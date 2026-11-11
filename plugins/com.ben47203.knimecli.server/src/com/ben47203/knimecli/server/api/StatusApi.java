package com.ben47203.knimecli.server.api;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.NodeMessage;
import org.knime.core.node.workflow.SubNodeContainer;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.api.NodeEndpoint.NodeTarget;
import com.ben47203.knimecli.server.api.NodeStates.NodeState;
import com.ben47203.knimecli.server.api.WorkflowEndpoint.WorkflowTarget;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Node and workflow state, read from core {@link WorkflowManager} calls without changing anything. */
final class StatusApi {

    private StatusApi() {
    }

    static List<Endpoint<?>> endpoints() {
        return List.of(new NodeStatus(), new WorkflowState(), new WorkflowErrors());
    }

    /** {@code POST /api/node/status}: one node's state, message, timing and output port summaries. */
    static final class NodeStatus extends NodeEndpoint<NodeTarget> {
        NodeStatus() {
            super("node/status", Tier.READ, NodeTarget.class);
        }

        /** One output port, without touching its data beyond the port object's own summary. */
        record Port(int index, String type, String summary, boolean inactive) {
        }

        @Override
        Object execute(final WorkflowManager wfm, final NodeContainer nc, final NodeTarget request) {
            var ports = new ArrayList<Port>();
            for (var i = 0; i < nc.getNrOutPorts(); i++) {
                var port = nc.getOutPort(i);
                ports.add(new Port(i, port.getPortType().getName(), port.getPortSummary(), port.isInactive()));
            }
            ObjectNode res = RESPONSE_MAPPER.valueToTree(NodeStates.describe(nc));
            res.set("outPorts", RESPONSE_MAPPER.valueToTree(ports));
            return res;
        }
    }

    /** {@code POST /api/workflow/state}: every node's state plus a {@code stateHash}; cheap enough to poll. */
    static final class WorkflowState extends WorkflowEndpoint<WorkflowTarget> {
        WorkflowState() {
            super("workflow/state", Tier.READ, WorkflowTarget.class);
        }

        @Override
        Object execute(final WorkflowManager wfm, final WorkflowTarget request) throws Exception {
            var nodes = NodeStates.children(wfm).stream().map(NodeStates::describe).toList();
            var res = new LinkedHashMap<String, Object>();
            res.put("stateHash", NodeStates.stateHash(nodes));
            res.put("nodes", nodes);
            return res;
        }
    }

    /**
     * {@code POST /api/workflow/errors}: every node with a warning or error, recursing into metanodes and components
     * (ids are gateway ids at any depth, e.g. {@code root:5:0:2}). Locked components are reported as a whole.
     */
    static final class WorkflowErrors extends WorkflowEndpoint<WorkflowTarget> {
        WorkflowErrors() {
            super("workflow/errors", Tier.READ, WorkflowTarget.class);
        }

        @Override
        Object execute(final WorkflowManager wfm, final WorkflowTarget request) {
            var nodes = new ArrayList<NodeState>();
            collectMessages(wfm, nodes);
            var errors = nodes.stream().filter(n -> NodeMessage.Type.ERROR.name().equals(n.message().type())).count();
            var res = new LinkedHashMap<String, Object>();
            res.put("errors", errors);
            res.put("warnings", nodes.size() - errors);
            res.put("nodes", nodes);
            return res;
        }

        private static void collectMessages(final WorkflowManager wfm, final List<NodeState> out) {
            for (var nc : NodeStates.children(wfm)) {
                var inner = nc instanceof SubNodeContainer snc ? snc.getWorkflowManager()
                    : nc instanceof WorkflowManager meta ? meta : null;
                if (inner != null && (!inner.isEncrypted() || inner.isUnlocked())) {
                    collectMessages(inner, out);
                } else {
                    var state = NodeStates.describe(nc);
                    if (state.message() != null) {
                        out.add(state);
                    }
                }
            }
        }
    }
}
