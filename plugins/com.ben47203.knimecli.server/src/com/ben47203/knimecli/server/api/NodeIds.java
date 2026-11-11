package com.ben47203.knimecli.server.api;

import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.NodeID;
import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.api.entity.NodeIDEnt;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/**
 * The one place that converts between core {@link NodeID}s and the gateway's {@link NodeIDEnt} string form
 * ({@code root:3}, {@code root:5:0:2}), so ids in our responses match {@code /api/workflow} and the UI.
 *
 * <p>
 * Both directions go through the project workflow, the way the gateway's own entity factories do: the gateway form
 * drops the project's own id prefix, plus the extra {@code 0} level of a component project.
 */
public final class NodeIds {

    private NodeIds() {
    }

    /** Gateway id of a node, a metanode or a component, at any depth. */
    static NodeIDEnt toEnt(final NodeContainer nc) {
        return new NodeIDEnt(nc.getID(), nc.getParent());
    }

    /** Gateway id string of a node, as used in responses. */
    public static String toId(final NodeContainer nc) {
        return toEnt(nc).toString();
    }

    /** Core id for a gateway id within the project that {@code wfm} belongs to. */
    static NodeID toNodeId(final NodeIDEnt ent, final WorkflowManager wfm) {
        return ent.toNodeID(wfm);
    }

    /** Parses a request's gateway id string into a core id; 400 if it isn't one. */
    static NodeID parse(final String id, final String field, final WorkflowManager wfm) throws ApiException {
        return toNodeId(Requests.nodeIdEnt(id, field), wfm);
    }
}
