package com.ben47203.knimecli.server.api;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.knime.core.node.InvalidSettingsException;
import org.knime.core.node.NodeSettings;
import org.knime.core.node.config.base.ConfigBase;
import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.SubNodeContainer;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.api.NodeEndpoint.NodeRef;
import com.ben47203.knimecli.server.api.NodeEndpoint.NodeTarget;
import com.ben47203.knimecli.server.api.NodeStates.Message;
import com.ben47203.knimecli.server.api.NodeStates.State;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Node settings as JSON, via core {@link NodeContainer#getNodeSettings()}: the same settings a dialog's Apply writes,
 * minus passwords and credentials (see {@link Secrets}).
 */
final class SettingsApi {

    /** The node's own settings, as passed to {@code NodeModel.loadSettingsFrom}. */
    static final String MODEL = "model";

    /** Flow-variable bindings of the model settings; holds variable names only. */
    static final String VARIABLES = "variables";

    private SettingsApi() {
    }

    static List<Endpoint<?>> endpoints() {
        return List.of(new GetSettings(), new SetSettings());
    }

    /**
     * A node's settings. {@code redacted} lists the JSON Pointers of secrets replaced by {@code {"$redacted": true}}.
     */
    record Settings(String nodeId, String kind, Object model, Object variables, List<String> redacted) {
    }

    /**
     * {@code POST /api/node/settings}: the model settings and flow-variable bindings of a node or component. Job
     * manager, memory policy and view settings are left out.
     */
    static final class GetSettings extends NodeEndpoint<NodeTarget> {
        GetSettings() {
            super("node/settings", Tier.READ, NodeTarget.class);
        }

        @Override
        Object execute(final WorkflowManager wfm, final NodeContainer nc, final NodeTarget request)
            throws ApiException {
            var kind = kind(nc);
            var settings = nc.getNodeSettings(); // fills in defaults for nodes that were never configured
            var redacted = new ArrayList<String>();
            return new Settings(NodeIds.toId(nc), kind, section(settings, MODEL, redacted),
                section(settings, VARIABLES, redacted), redacted);
        }
    }

    /** A patch for one node's model settings; see {@link SettingsJson#applyPatch}. */
    record SetRequest(String projectId, String workflowId, String nodeId, JsonNode model) implements NodeRef {
        SetRequest {
            Requests.require(projectId, "projectId");
            Requests.require(nodeId, "nodeId");
            if (model == null || !model.isObject() || model.isEmpty()) {
                throw new IllegalArgumentException("model must be a non-empty JSON object of the settings to change");
            }
        }
    }

    /**
     * Outcome of a set. {@code changed} is false when the patch matched the current settings, in which case the node
     * was left alone; otherwise it and its successors were reset and reconfigured, and {@code message} is the warning
     * or error configuring left on it.
     */
    record SetResult(boolean changed, String nodeId, State state, Message message, Object model,
        List<String> redacted) {
    }

    /**
     * {@code POST /api/node/settings/set}: patches a node's model settings and loads them, as a dialog's Apply does.
     * Like Apply, this resets the node and its successors and can't be undone. If the node's dialog is open in the
     * UI it keeps showing the old values, and applying from it overwrites this change.
     *
     * <p>
     * 409 if the node or a successor is queued or executing, or the node can't be edited; 400 for an invalid patch or settings the node rejects,
     * in which case nothing changed. 400 too if loading would change the node's secrets: the old settings are then
     * restored, but the node has still been reset.
     */
    static final class SetSettings extends NodeEndpoint<SetRequest> {
        SetSettings() {
            super("node/settings/set", Tier.WRITE, SetRequest.class);
        }

        @Override
        @SuppressWarnings("try") // the lock is held, not used
        Object execute(final WorkflowManager wfm, final NodeContainer nc, final SetRequest request)
            throws ApiException {
            kind(nc);
            boolean changed;
            // Read, compare and load under one lock hold, so nothing can start executing or change in between.
            try (var lock = wfm.lock()) {
                var current = nc.getNodeSettings();
                var updated = nc.getNodeSettings(); // a second, independent copy to patch
                if (!(Secrets.entry(updated, MODEL) instanceof ConfigBase model)) {
                    throw new ApiException(400, NodeIds.toId(nc) + " has no model settings");
                }
                SettingsJson.applyPatch(model, request.model(), SettingsJson.child("", MODEL));
                // Core always resets on load; skipping no-ops keeps executed results, as the UI's Apply does.
                changed = !updated.equals(current);
                if (changed) {
                    load(wfm, nc, updated, current);
                }
            }
            var redacted = new ArrayList<String>();
            var model = section(nc.getNodeSettings(), MODEL, redacted);
            return new SetResult(changed, NodeIds.toId(nc), NodeStates.state(nc), NodeStates.message(nc), model,
                redacted);
        }

        /**
         * Loads {@code updated}, then checks the node's secrets survived. The patch can't touch them, but a node may
         * drop or re-key one while loading (e.g. after an authentication type changed); then the old settings are
         * restored rather than leaving a node whose credentials changed behind the user's back.
         */
        private static void load(final WorkflowManager wfm, final NodeContainer nc, final NodeSettings updated,
            final NodeSettings current) throws ApiException {
            var id = nc.getID();
            if (!wfm.canModifyStructure(id)) {
                throw new ApiException(409, "Cannot change settings of " + NodeIds.toId(nc)
                    + ": it or a successor is queued or executing (cancel or wait for it first),"
                    + " or it sits in a write-protected component");
            }
            var secrets = Secrets.snapshot(current);
            try {
                wfm.loadNodeSettings(id, updated);
            } catch (InvalidSettingsException e) {
                throw new ApiException(400, "The node rejected these settings: " + e.getMessage());
            } catch (IllegalStateException e) { // NOSONAR: a race with execution the check above didn't catch
                throw new ApiException(409, "Cannot change settings of " + NodeIds.toId(nc) + ": " + e.getMessage());
            }
            if (!Secrets.sameSecrets(secrets, nc.getNodeSettings())) {
                try {
                    wfm.loadNodeSettings(id, current);
                } catch (InvalidSettingsException e) { // NOSONAR: the node held these settings a moment ago
                    throw new ApiException(500, "Loading the new settings changed the node's passwords or"
                        + " credentials, and restoring the old settings failed: " + e.getMessage());
                }
                throw new ApiException(400, "Loading these settings would have changed the node's passwords or"
                    + " credentials, so the old settings were restored (the node was still reset)");
            }
        }
    }

    /** {@code native} or {@code component}; 400 for a metanode, which has no settings of its own. */
    static String kind(final NodeContainer nc) throws ApiException {
        if (nc instanceof WorkflowManager) {
            throw new ApiException(400, NodeIds.toId(nc) + " is a metanode, which has no settings of its own;"
                + " pass it as workflowId to reach the nodes inside it");
        }
        return nc instanceof SubNodeContainer ? "component" : "native";
    }

    /** One top-level section as JSON, or an empty object if the node has none. */
    private static Object section(final NodeSettings settings, final String key, final List<String> redacted) {
        if (Secrets.entry(settings, key) instanceof ConfigBase section) {
            return SettingsJson.toJson(section, redacted, SettingsJson.child("", key));
        }
        return Map.of();
    }
}
