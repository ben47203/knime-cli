package com.ben47203.knimecli.server.api.ports;

import java.util.List;

import org.knime.core.data.BooleanValue;
import org.knime.core.data.DataCell;
import org.knime.core.data.DataColumnSpec;
import org.knime.core.data.DataTableSpec;
import org.knime.core.data.DoubleValue;
import org.knime.core.data.IntValue;
import org.knime.core.data.LongValue;
import org.knime.core.node.port.PortObjectSpec;
import org.knime.core.node.port.PortType;
import org.knime.core.node.port.flowvariable.FlowVariablePortObject;
import org.knime.core.node.port.flowvariable.FlowVariablePortObjectSpec;
import org.knime.core.node.port.inactive.InactiveBranchPortObjectSpec;
import org.knime.core.node.workflow.ConnectionContainer;
import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.NodeID;
import org.knime.core.node.workflow.NodeOutPort;
import org.knime.core.node.workflow.NodePort;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.api.Endpoint;
import com.ben47203.knimecli.server.api.NodeEndpoint;
import com.ben47203.knimecli.server.api.NodeEndpoint.NodeTarget;
import com.ben47203.knimecli.server.api.NodeIds;
import com.ben47203.knimecli.server.api.NodeStates;
import com.ben47203.knimecli.server.api.NodeStates.State;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * A node's input and output ports with the specs configure produced, so clients can see column names and types
 * without executing anything or guessing. Never returns table data.
 */
public final class PortsApi {

    /** Most possible values listed per nominal column; {@code valuesTruncated} says when there were more. */
    static final int MAX_VALUES = 50;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private PortsApi() {
    }

    public static List<Endpoint<?>> endpoints() {
        return List.of(new GetPorts());
    }

    /**
     * {@code POST /api/node/ports}: every input and output port of a node, metanode or component. An input reports
     * the spec arriving from upstream, i.e. its predecessor's output spec. A port without a spec has {@code spec: null}
     * and a {@code reason}, except a flow-variable port, which always reports its kind.
     *
     * <p>
     * Only a port's name, type and, for tables, column names, types and domains are reported: column properties and
     * other spec contents could hold anything. Flow-variable ports list no variables at all, not even names, so
     * credentials stay out.
     */
    static final class GetPorts extends NodeEndpoint<NodeTarget> {
        GetPorts() {
            super("node/ports", Tier.READ, NodeTarget.class);
        }

        @Override
        @SuppressWarnings("try") // the lock is held, not used
        protected Object execute(final WorkflowManager wfm, final NodeContainer nc, final NodeTarget request) {
            var res = JSON.objectNode();
            res.put("nodeId", NodeIds.toId(nc));
            // One lock hold so the ports, connections and specs all come from the same moment.
            try (var lock = wfm.lock()) {
                var inputs = res.putArray("inputs");
                for (var i = 0; i < nc.getNrInPorts(); i++) {
                    inputs.add(input(wfm, nc, i));
                }
                var outputs = res.putArray("outputs");
                for (var i = 0; i < nc.getNrOutPorts(); i++) {
                    outputs.add(output(wfm, nc, i));
                }
            }
            return res;
        }
    }

    private static ObjectNode input(final WorkflowManager wfm, final NodeContainer nc, final int index) {
        var port = nc.getInPort(index);
        var json = header(index, port);
        var cc = wfm.getIncomingConnectionFor(nc.getID(), index);
        json.put("connected", cc != null);
        if (cc == null) {
            setSpec(json, port.getPortType(), null, "not connected");
            return json;
        }
        json.set("connectedFrom", end(wfm, cc.getSource(), cc.getSourcePort()));
        var source = sourcePort(wfm, cc);
        var spec = source == null ? null : source.getPortObjectSpec();
        setSpec(json, port.getPortType(), spec, spec == null ? upstreamReason(wfm, cc) : null);
        if (source != null) {
            putSummary(json, source);
        }
        return json;
    }

    private static ObjectNode output(final WorkflowManager wfm, final NodeContainer nc, final int index) {
        var port = nc.getOutPort(index);
        var json = header(index, port);
        var targets = json.putArray("connectedTo");
        for (var cc : wfm.getOutgoingConnectionsFor(nc.getID(), index)) {
            targets.add(end(wfm, cc.getDest(), cc.getDestPort()));
        }
        var spec = port.getPortObjectSpec();
        setSpec(json, port.getPortType(), spec, spec == null ? outputReason(wfm, nc) : null);
        putSummary(json, port);
        return json;
    }

    private static ObjectNode header(final int index, final NodePort port) {
        var json = JSON.objectNode();
        json.put("index", index);
        var name = port.getPortName();
        if (name != null && !name.isBlank()) {
            json.put("name", name);
        }
        var type = port.getPortType();
        json.put("type", type.getName());
        if (type.isOptional()) {
            json.put("optional", true);
        }
        return json;
    }

    /**
     * The other end of a connection. A connection to or from the enclosing metanode's own port bar has that metanode
     * as its node.
     */
    private static ObjectNode end(final WorkflowManager wfm, final NodeID id, final int index) {
        var nc = id.equals(wfm.getID()) ? wfm : wfm.getNodeContainer(id);
        var json = JSON.objectNode();
        json.put("nodeId", NodeIds.toId(nc));
        json.put("index", index);
        return json;
    }

    /** The output port feeding a connection: a predecessor's, or the enclosing metanode's input bar. */
    private static NodeOutPort sourcePort(final WorkflowManager wfm, final ConnectionContainer cc) {
        if (cc.getSource().equals(wfm.getID())) {
            return wfm.getWorkflowIncomingPort(cc.getSourcePort());
        }
        return wfm.tryGetNodeContainer(cc.getSource()).map(src -> src.getOutPort(cc.getSourcePort())).orElse(null);
    }

    /**
     * Why an output has no spec. A node configures only once every required input has a spec, so a missing or
     * spec-less upstream is the usual cause. Otherwise either the node refused to configure, and its message says why,
     * or it configured without a spec for this port: some nodes, such as a CSV Reader whose dialog was never applied,
     * only know their output once they have executed.
     */
    private static String outputReason(final WorkflowManager wfm, final NodeContainer nc) {
        for (var i = 0; i < nc.getNrInPorts(); i++) {
            var port = nc.getInPort(i);
            if (port.getPortType().isOptional()) {
                continue;
            }
            var cc = wfm.getIncomingConnectionFor(nc.getID(), i);
            if (cc == null) {
                return "input " + i + " not connected";
            }
            var source = sourcePort(wfm, cc);
            if (source == null || source.getPortObjectSpec() == null) {
                return upstreamReason(wfm, cc);
            }
        }
        if (NodeStates.state(nc) != State.IDLE) {
            return "no spec until the node executes";
        }
        var message = NodeStates.message(nc);
        return message == null ? "node not configured" : "node not configured: " + message.text();
    }

    /** Why a connection delivers no spec: its source isn't configured, or configured without one (see above). */
    private static String upstreamReason(final WorkflowManager wfm, final ConnectionContainer cc) {
        var source = cc.getSource().equals(wfm.getID()) ? wfm : wfm.getNodeContainer(cc.getSource());
        return NodeStates.state(source) == State.IDLE ? "upstream not configured"
            : "upstream has no spec until it executes";
    }

    private static void setSpec(final ObjectNode json, final PortType type, final PortObjectSpec spec,
        final String reason) {
        if (spec == null && FlowVariablePortObject.class.equals(type.getPortObjectClass())) {
            // Known from the type alone: a flow-variable spec carries nothing, and we list no variables anyway.
            json.set("spec", spec(type, FlowVariablePortObjectSpec.INSTANCE));
        } else if (spec == null) {
            json.putNull("spec");
            json.put("reason", reason);
        } else {
            json.set("spec", spec(type, spec));
        }
    }

    private static void putSummary(final ObjectNode json, final NodeOutPort port) {
        var summary = port.getPortSummary();
        if (summary != null && !summary.isBlank()) {
            json.put("summary", summary);
        }
    }

    /** A spec as JSON: tables in full (names, types, domains), everything else by kind only. */
    static ObjectNode spec(final PortType type, final PortObjectSpec spec) {
        var json = JSON.objectNode();
        if (spec instanceof InactiveBranchPortObjectSpec) {
            json.put("kind", "inactive");
        } else if (spec instanceof FlowVariablePortObjectSpec
            || FlowVariablePortObject.class.equals(type.getPortObjectClass())) {
            json.put("kind", "flowVariables"); // deliberately no variables, see GetPorts
        } else if (spec instanceof DataTableSpec table) {
            json.put("kind", "table");
            var columns = json.putArray("columns");
            for (var column : table) {
                columns.add(column(column));
            }
        } else {
            json.put("kind", type.getName());
        }
        return json;
    }

    private static ObjectNode column(final DataColumnSpec column) {
        var json = JSON.objectNode();
        json.put("name", column.getName());
        json.put("type", column.getType().getName());
        var domain = column.getDomain();
        if (domain.hasValues() || domain.hasBounds()) {
            var d = json.putObject("domain");
            if (domain.hasValues()) {
                var all = domain.getValues();
                var values = d.putArray("values");
                for (var cell : all) {
                    if (values.size() == MAX_VALUES) {
                        break;
                    }
                    values.add(cell(cell));
                }
                if (all.size() > MAX_VALUES) {
                    d.put("valuesTruncated", true);
                    d.put("valueCount", all.size());
                }
            }
            if (domain.hasLowerBound()) {
                d.set("lower", cell(domain.getLowerBound()));
            }
            if (domain.hasUpperBound()) {
                d.set("upper", cell(domain.getUpperBound()));
            }
        }
        return json;
    }

    /** A domain value: numbers and booleans as JSON ones, a missing cell as null, anything else as its text. */
    private static JsonNode cell(final DataCell cell) {
        if (cell == null || cell.isMissing()) {
            return JSON.nullNode();
        } else if (cell instanceof BooleanValue v) { // before IntValue: a BooleanCell is an IntValue too
            return JSON.booleanNode(v.getBooleanValue());
        } else if (cell instanceof IntValue v) {
            return JSON.numberNode(v.getIntValue());
        } else if (cell instanceof LongValue v) {
            return JSON.numberNode(v.getLongValue());
        } else if (cell instanceof DoubleValue v && Double.isFinite(v.getDoubleValue())) {
            return JSON.numberNode(v.getDoubleValue());
        }
        return JSON.textNode(cell.toString());
    }
}
