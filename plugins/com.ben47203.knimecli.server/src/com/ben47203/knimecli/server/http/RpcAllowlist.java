package com.ben47203.knimecli.server.http;

import java.io.IOException;
import java.util.Set;

// Writing JSON by hand (Json.java) is easy; parsing it safely is not. Jackson is already part of the KNIME runtime
// (no extra dependency) and is the parser the gateway uses, so requests are read the same way on both sides and a
// method can't slip through on an escaping or case quirk.
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Only forwards gateway methods that are safe to call alongside the KNIME UI.
 *
 * <p>
 * The gateway was built for exactly one client (the UI) and many of its methods change state the UI depends on. The
 * worst example is {@code WorkflowService.getWorkflow}: it commits a snapshot to a per-workflow repository that keeps
 * only <b>one</b> snapshot, which evicts the UI's snapshot. The UI's next change event then fails ("No workflow found
 * for snapshot") and the editor stops responding. {@code ApplicationService.getState} similarly replaces the UI's
 * app-state diff baseline. So this is an allowlist, not a denylist: anything not known to be safe is refused.
 * Reads go through our own side-effect-free {@code /api/*} endpoints instead.
 */
public final class RpcAllowlist implements LocalApiServer.RpcHandler {

    /**
     * Verified safe: these run through the shared command stack (so the UI can undo them) and change the workflow
     * only, which the UI picks up through its own change events.
     */
    static final Set<String> ALLOWED = Set.of( //
        "WorkflowService.executeWorkflowCommand", //
        "WorkflowService.undoWorkflowCommand", //
        "WorkflowService.redoWorkflowCommand");

    /** JSON-RPC server-defined error range (-32000 to -32099). */
    static final int NOT_ALLOWED = -32001;

    private final LocalApiServer.RpcHandler m_delegate;

    /**
     * Stricter than the gateway's parser on purpose: input that two parsers could read differently (duplicate keys,
     * content after the request object) is refused instead of relying on both resolving it the same way.
     */
    private final ObjectMapper m_mapper = new ObjectMapper()
        .enable(DeserializationFeature.FAIL_ON_READING_DUP_TREE_KEY, DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public RpcAllowlist(final LocalApiServer.RpcHandler delegate) {
        m_delegate = delegate;
    }

    @Override
    public byte[] handle(final byte[] request) {
        JsonNode node;
        try {
            node = m_mapper.readTree(request);
        } catch (IOException e) {
            return error(null, -32700, "Parse error");
        }
        if (node == null || !node.isObject()) {
            return error(null, -32600, "Only single JSON-RPC request objects are supported (no batches)");
        }
        var id = node.get("id");
        var method = node.path("method");
        if (!method.isTextual()) {
            return error(id, -32600, "Missing method");
        }
        if (!ALLOWED.contains(method.asText())) {
            return error(id, NOT_ALLOWED, "Method not available via knime-cli: " + method.asText()
                + " (it would interfere with the KNIME UI; use the /api endpoints for reads)");
        }
        return m_delegate.handle(request);
    }

    private byte[] error(final JsonNode id, final int code, final String message) {
        ObjectNode res = m_mapper.createObjectNode().put("jsonrpc", "2.0");
        res.set("id", id == null ? m_mapper.nullNode() : id);
        res.putObject("error").put("code", code).put("message", message);
        try {
            return m_mapper.writeValueAsBytes(res);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
