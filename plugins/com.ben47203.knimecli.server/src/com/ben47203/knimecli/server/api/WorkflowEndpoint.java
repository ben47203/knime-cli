package com.ben47203.knimecli.server.api;

import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.api.entity.NodeIDEnt;
import org.knime.gateway.impl.project.ProjectManager;
import org.knime.gateway.impl.service.util.DefaultServiceUtil;

import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;

/**
 * An endpoint scoped to one workflow (a project's root, or a metanode/component inside it). Resolves the
 * {@link WorkflowManager} before {@link #execute(WorkflowManager, WorkflowRef)} runs.
 *
 * @param <Q> request type, which names the workflow
 */
abstract class WorkflowEndpoint<Q extends WorkflowEndpoint.WorkflowRef> extends Endpoint<Q> {

    /** Implemented by request records that address a workflow. */
    interface WorkflowRef {
        /** Id of a project open in the UI, see {@code /api/projects}. */
        String projectId();

        /** Gateway node id of a metanode/component ({@code root:5}), or null for the project's root workflow. */
        String workflowId();
    }

    /** Request that names a workflow and nothing else. */
    record WorkflowTarget(String projectId, String workflowId) implements WorkflowRef {
        WorkflowTarget {
            Requests.require(projectId, "projectId");
        }
    }

    WorkflowEndpoint(final String path, final Tier tier, final Class<Q> requestType) {
        super(path, tier, requestType);
    }

    @Override
    Object run(final Q request) throws Exception {
        return execute(resolveWorkflow(request), request);
    }

    abstract Object execute(WorkflowManager wfm, Q request) throws Exception; // NOSONAR

    /** Gateway id of the workflow a request addresses, defaulting to the project root. */
    static NodeIDEnt workflowIdEnt(final WorkflowRef ref) throws ApiException {
        return ref.workflowId() == null ? NodeIDEnt.getRootID() : Requests.nodeIdEnt(ref.workflowId(), "workflowId");
    }

    private static WorkflowManager resolveWorkflow(final WorkflowRef ref) throws ApiException {
        // Only projects already open in the UI: resolving an unknown id would make KNIME load it behind the UI's back.
        if (!ProjectManager.getInstance().getProjectIds().contains(ref.projectId())) {
            throw new ApiException(404, "No open project with id " + ref.projectId());
        }
        var workflowId = workflowIdEnt(ref);
        try {
            return DefaultServiceUtil.getWorkflowManager(ref.projectId(), workflowId);
        } catch (IllegalArgumentException e) { // no node with that id
            throw new ApiException(404, "No workflow " + workflowId + " in project " + ref.projectId());
        } catch (IllegalStateException e) { // node isn't a metanode/component, or the component is locked
            throw new ApiException(400, e.getMessage());
        }
    }
}
