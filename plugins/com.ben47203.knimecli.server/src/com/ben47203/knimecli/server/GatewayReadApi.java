package com.ben47203.knimecli.server;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.knime.core.node.workflow.WorkflowManager;
import org.knime.gateway.api.entity.NodeIDEnt;
import org.knime.gateway.api.webui.util.EntityFactory;
import org.knime.gateway.api.webui.util.WorkflowBuildContext;
import org.knime.gateway.impl.project.Project;
import org.knime.gateway.impl.project.ProjectManager;
import org.knime.gateway.impl.service.util.DefaultServiceUtil;
import org.knime.gateway.json.util.ObjectMapperUtil;

import com.ben47203.knimecli.server.LocalApiServer.ApiException;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Read endpoints that build gateway entities directly, without the gateway services' side effects. Unlike
 * {@code WorkflowService.getWorkflow}, nothing is committed to the shared snapshot repository, so the KNIME UI's change
 * tracking is untouched. See {@link RpcAllowlist}.
 */
final class GatewayReadApi {

    private final ObjectMapper m_mapper = ObjectMapperUtil.getInstance().getObjectMapper();

    /** {@code POST /api/projects}, body {@code {}}: the projects open in the UI. */
    byte[] projects(final byte[] body) throws Exception {
        var pm = ProjectManager.getInstance();
        List<Map<String, Object>> projects = pm.getProjectIds().stream().<Map<String, Object>> map(id -> {
            var p = new LinkedHashMap<String, Object>();
            p.put("projectId", id);
            p.put("name", pm.getProject(id).map(Project::getName).orElse(null));
            return p;
        }).toList();
        return m_mapper.writeValueAsBytes(Map.of("projects", projects));
    }

    /**
     * {@code POST /api/workflow}, body {@code {"projectId": "...", "workflowId": "root"}}: the workflow entity (same
     * shape as the gateway's, without interaction info) plus a {@code contentHash} for change detection.
     */
    byte[] workflow(final byte[] body) throws Exception {
        JsonNode req;
        try {
            req = m_mapper.readTree(body);
        } catch (JsonProcessingException e) {
            throw new ApiException(400, "Request body must be a JSON object");
        }
        var projectId = text(req, "projectId");
        if (projectId == null) {
            throw new ApiException(400, "projectId is required");
        }
        // Only projects already open in the UI: resolving an unknown id would make KNIME load it behind the UI's back.
        if (!ProjectManager.getInstance().getProjectIds().contains(projectId)) {
            throw new ApiException(404, "No open project with id " + projectId);
        }
        var workflowIdText = text(req, "workflowId");
        NodeIDEnt workflowId;
        try {
            workflowId = workflowIdText == null ? NodeIDEnt.getRootID() : new NodeIDEnt(workflowIdText);
        } catch (RuntimeException e) { // NOSONAR: any parse failure is a client error
            throw new ApiException(400, "Invalid workflowId: " + workflowIdText);
        }
        WorkflowManager wfm;
        try {
            wfm = DefaultServiceUtil.getWorkflowManager(projectId, workflowId);
        } catch (IllegalArgumentException e) { // no node with that id
            throw new ApiException(404, "No workflow " + workflowId + " in project " + projectId);
        } catch (IllegalStateException e) { // node isn't a metanode/component, or the component is locked
            throw new ApiException(400, e.getMessage());
        }
        // Builds under the workflow lock; no snapshot commit, no UI-visible state change.
        var workflow = EntityFactory.Workflow.buildWorkflowEnt(wfm,
            WorkflowBuildContext.builder().includeInteractionInfo(false));
        var workflowJson = m_mapper.valueToTree(workflow);
        var res = new LinkedHashMap<String, Object>();
        res.put("contentHash", sha256(m_mapper.writeValueAsBytes(workflowJson)));
        res.put("workflow", workflowJson);
        return m_mapper.writeValueAsBytes(res);
    }

    private static String text(final JsonNode node, final String field) {
        var v = node == null ? null : node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    private static String sha256(final byte[] bytes) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
