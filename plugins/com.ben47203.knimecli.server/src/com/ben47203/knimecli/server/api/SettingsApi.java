package com.ben47203.knimecli.server.api;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.knime.core.node.NodeSettings;
import org.knime.core.node.config.base.ConfigBase;
import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.SubNodeContainer;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.api.NodeEndpoint.NodeTarget;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

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
        return List.of(new GetSettings());
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
