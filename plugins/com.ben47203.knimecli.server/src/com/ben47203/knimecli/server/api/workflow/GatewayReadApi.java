package com.ben47203.knimecli.server.api.workflow;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.api.webui.util.EntityFactory;
import org.knime.gateway.api.webui.util.WorkflowBuildContext;
import org.knime.gateway.impl.project.Project;
import org.knime.gateway.impl.project.ProjectManager;

import com.ben47203.knimecli.server.api.Endpoint;
import com.ben47203.knimecli.server.api.Endpoint.NoArgs;
import com.ben47203.knimecli.server.api.NodeStates;
import com.ben47203.knimecli.server.api.WorkflowEndpoint;
import com.ben47203.knimecli.server.api.WorkflowEndpoint.WorkflowTarget;

/**
 * Read endpoints that build gateway entities directly, without the gateway services' side effects. Unlike
 * {@code WorkflowService.getWorkflow}, nothing is committed to the shared snapshot repository, so the KNIME UI's change
 * tracking is untouched. See {@link RpcAllowlist}.
 */
public final class GatewayReadApi {

    private GatewayReadApi() {
    }

    public static List<Endpoint<?>> endpoints() {
        return List.of(new Projects(), new Workflow());
    }

    /** {@code POST /api/projects}, body {@code {}}: the projects open in the UI. */
    static final class Projects extends Endpoint<NoArgs> {
        Projects() {
            super("projects", Tier.READ, NoArgs.class);
        }

        @Override
        protected Object run(final NoArgs request) {
            var pm = ProjectManager.getInstance();
            List<Map<String, Object>> projects = pm.getProjectIds().stream().<Map<String, Object>> map(id -> {
                var p = new LinkedHashMap<String, Object>();
                p.put("projectId", id);
                p.put("name", pm.getProject(id).map(Project::getName).orElse(null));
                return p;
            }).toList();
            return Map.of("projects", projects);
        }
    }

    /**
     * {@code POST /api/workflow}, body {@code {"projectId": "...", "workflowId": "root"}}: the workflow entity (same
     * shape as the gateway's, without interaction info) plus a {@code contentHash} for change detection.
     */
    static final class Workflow extends WorkflowEndpoint<WorkflowTarget> {
        Workflow() {
            super("workflow", Tier.READ, WorkflowTarget.class);
        }

        @Override
        protected Object execute(final WorkflowManager wfm, final WorkflowTarget request) throws Exception {
            // Builds under the workflow lock; no snapshot commit, no UI-visible state change.
            var workflow = EntityFactory.Workflow.buildWorkflowEnt(wfm,
                WorkflowBuildContext.builder().includeInteractionInfo(false));
            var workflowJson = RESPONSE_MAPPER.valueToTree(workflow);
            var res = new LinkedHashMap<String, Object>();
            res.put("contentHash", NodeStates.sha256(RESPONSE_MAPPER.writeValueAsBytes(workflowJson)));
            res.put("workflow", workflowJson);
            return res;
        }
    }
}
