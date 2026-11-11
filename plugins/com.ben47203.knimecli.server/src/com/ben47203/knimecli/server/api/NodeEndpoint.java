package com.ben47203.knimecli.server.api;

import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/**
 * An endpoint scoped to one node of a workflow. Resolves the {@link NodeContainer} before
 * {@link #execute(WorkflowManager, NodeContainer, NodeRef)} runs.
 *
 * @param <Q> request type, which names the workflow and the node
 */
public abstract class NodeEndpoint<Q extends NodeEndpoint.NodeRef> extends WorkflowEndpoint<Q> {

    /** Implemented by request records that address a node. */
    public interface NodeRef extends WorkflowRef {
        /** Gateway node id ({@code root:3}) of a node directly inside the addressed workflow. */
        String nodeId();
    }

    /** Request that names a node and nothing else. */
    public record NodeTarget(String projectId, String workflowId, String nodeId) implements NodeRef {
        public NodeTarget {
            Requests.require(projectId, "projectId");
            Requests.require(nodeId, "nodeId");
        }
    }

    protected NodeEndpoint(final String path, final Tier tier, final Class<Q> requestType) {
        super(path, tier, requestType);
    }

    @Override
    protected final Object execute(final WorkflowManager wfm, final Q request) throws Exception {
        return execute(wfm, resolveNode(wfm, request.nodeId(), "nodeId"), request);
    }

    protected abstract Object execute(WorkflowManager wfm, NodeContainer nc, Q request) throws Exception; // NOSONAR

    /**
     * The node with the given gateway id, which must sit directly in {@code wfm}: a node deeper down is addressed by
     * naming its metanode/component as the {@code workflowId}, which keeps every id unambiguous.
     */
    public static NodeContainer resolveNode(final WorkflowManager wfm, final String nodeId, final String field)
        throws ApiException {
        var id = NodeIds.parse(nodeId, field, wfm);
        return wfm.tryGetNodeContainer(id)
            .orElseThrow(() -> new ApiException(404, "No node " + nodeId
                + " in this workflow; for a node inside a metanode/component, pass that as workflowId"));
    }
}
