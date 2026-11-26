package com.ben47203.knimecli.server.api.settings;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

import org.knime.core.node.InvalidSettingsException;
import org.knime.core.node.NodeLogger;
import org.knime.core.node.NodeModel;
import org.knime.core.node.NodeSettings;
import org.knime.core.node.NodeSettingsWO;
import org.knime.core.node.config.base.ConfigBase;
import org.knime.core.node.workflow.NativeNodeContainer;
import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.NodeContext;
import org.knime.core.node.workflow.SubNodeContainer;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.api.Endpoint;
import com.ben47203.knimecli.server.api.NodeEndpoint;
import com.ben47203.knimecli.server.api.NodeEndpoint.NodeRef;
import com.ben47203.knimecli.server.api.NodeEndpoint.NodeTarget;
import com.ben47203.knimecli.server.api.NodeIds;
import com.ben47203.knimecli.server.api.NodeStates;
import com.ben47203.knimecli.server.api.NodeStates.Message;
import com.ben47203.knimecli.server.api.NodeStates.State;
import com.ben47203.knimecli.server.api.Reflected;
import com.ben47203.knimecli.server.api.Requests;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Node settings as JSON, via core {@link NodeContainer#getNodeSettings()}: the same settings a dialog's Apply writes,
 * minus passwords and credentials (see {@link Secrets}).
 */
public final class SettingsApi {

    /** The node's own settings, as passed to {@code NodeModel.loadSettingsFrom}. */
    static final String MODEL = "model";

    /** Flow-variable bindings of the model settings; holds variable names only. */
    static final String VARIABLES = "variables";

    private static final NodeLogger LOGGER = NodeLogger.getLogger(SettingsApi.class);

    /**
     * {@code NodeModel.saveSettingsTo}, which is protected. Core's own caller ({@code Node.saveModelSettingsTo})
     * catches and only logs what the node throws, so calling it directly is the one way to see that exception. If it
     * can't be reached, reads aren't checked for completeness.
     */
    private static final Reflected<Method> SAVE_SETTINGS_TO = Reflected.find("NodeModel.saveSettingsTo",
        "incomplete node settings won't be flagged",
        () -> NodeModel.class.getDeclaredMethod("saveSettingsTo", NodeSettingsWO.class));

    private SettingsApi() {
    }

    public static List<Endpoint<?>> endpoints() {
        return List.of(new GetSettings(), new SetSettings());
    }

    /**
     * A node's settings. {@code redacted} lists the JSON Pointers of secrets replaced by {@code {"$redacted": true}}.
     * {@code complete} is false if the node failed to save its own settings, so {@code model} stops at the last key it
     * wrote; {@code problem} then says why (and is absent otherwise). See {@link #problem}.
     */
    record Settings(String nodeId, String kind, boolean complete, String problem, JsonNode model, JsonNode variables,
        List<String> redacted) {
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
        @SuppressWarnings("try") // the lock is held, not used
        protected Object execute(final WorkflowManager wfm, final NodeContainer nc, final NodeTarget request)
            throws ApiException {
            var kind = kind(nc);
            NodeSettings settings;
            String problem;
            try (var lock = wfm.lock()) { // so the check sees the node the read did
                settings = nc.getNodeSettings(); // fills in defaults for nodes that were never configured
                problem = problem(nc, settings);
            }
            var redacted = new ArrayList<String>();
            return new Settings(NodeIds.toId(nc), kind, problem == null, problem, section(settings, MODEL, redacted),
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
     * or error configuring left on it. {@code complete} and {@code problem} are as in {@link Settings}, for the
     * settings read back afterwards.
     */
    record SetResult(boolean changed, String nodeId, State state, Message message, boolean complete, String problem,
        JsonNode model, List<String> redacted) {
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
        protected Object execute(final WorkflowManager wfm, final NodeContainer nc, final SetRequest request)
            throws ApiException {
            kind(nc);
            boolean changed;
            NodeSettings after;
            String problem;
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
                after = nc.getNodeSettings();
                problem = problem(nc, after);
            }
            var redacted = new ArrayList<String>();
            var model = section(after, MODEL, redacted);
            return new SetResult(changed, NodeIds.toId(nc), NodeStates.state(nc), NodeStates.message(nc),
                problem == null, problem, model, redacted);
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
                var problem = problem(nc, current);
                throw new ApiException(400, "The node rejected these settings: " + e.getMessage()
                    + (problem == null ? "" : ". Note: " + problem));
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
    private static JsonNode section(final NodeSettings settings, final String key, final List<String> redacted) {
        if (Secrets.entry(settings, key) instanceof ConfigBase section) {
            return SettingsJson.toJson(section, redacted, SettingsJson.child("", key));
        }
        return SettingsJson.emptyObject();
    }

    /**
     * Why {@code read}, which {@code nc.getNodeSettings()} just returned, holds incomplete model settings; null if it
     * doesn't (or that can't be checked).
     *
     * <p>
     * For a node that has never loaded settings, core fills the model section by calling the node's
     * {@code saveSettingsTo}; if that throws, {@code Node.saveModelSettingsTo} logs "Could not save model" and core
     * carries on with whatever was written up to that point. The exception never reaches us, so the save is repeated
     * into a scratch settings object to see it. Once a node has loaded settings, core returns those instead, so a
     * failed save only explains {@code read} if {@code read}'s model is exactly what the failed save wrote.
     */
    static String problem(final NodeContainer nc, final NodeSettings read) {
        var saveSettingsTo = SAVE_SETTINGS_TO.orNull();
        if (!(nc instanceof NativeNodeContainer nnc) || saveSettingsTo == null) {
            return null; // NOSONAR: null means "complete"
        }
        var scratch = new NodeSettings(MODEL);
        Throwable failure = null;
        NodeContext.pushContext(nc);
        try {
            saveSettingsTo.invoke(nnc.getNodeModel(), scratch);
        } catch (InvocationTargetException e) {
            failure = e.getCause() != null ? e.getCause() : e;
        } catch (IllegalAccessException | RuntimeException e) { // NOSONAR: the check is best effort
            LOGGER.debug("Could not check whether the settings of " + nc.getNameWithID() + " are complete", e);
            return null;
        } finally {
            NodeContext.removeLastContext();
        }
        var model = Secrets.entry(read, MODEL);
        var fromFailedSave = model == null ? scratch.keySet().isEmpty() : model.equals(scratch);
        if (failure == null || !fromFailedSave) {
            return null;
        }
        var keys = new ArrayList<>(scratch.keySet());
        var where = keys.isEmpty() ? "before writing any key" : "after writing " + keys.get(keys.size() - 1);
        return "The node failed to save its own settings (" + failure.getClass().getSimpleName()
            + (failure.getMessage() == null ? "" : ": " + failure.getMessage()) + ") " + where
            + ", so model is incomplete and the node can't load it as is. Add the missing keys with typed values,"
            + " e.g. {\"key\": {\"$type\": \"string\", \"value\": \"...\"}}, through node/settings/set.";
    }

    /** For {@link com.ben47203.knimecli.server.api.Capabilities}. */
    public static Reflected<Method> saveSettingsTo() {
        return SAVE_SETTINGS_TO;
    }
}
