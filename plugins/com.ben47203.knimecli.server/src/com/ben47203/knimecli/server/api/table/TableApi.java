package com.ben47203.knimecli.server.api.table;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;

import org.knime.core.data.BooleanValue;
import org.knime.core.data.DataCell;
import org.knime.core.data.DataTableSpec;
import org.knime.core.data.DoubleValue;
import org.knime.core.data.IntValue;
import org.knime.core.data.LongValue;
import org.knime.core.data.container.filter.TableFilter;
import org.knime.core.node.BufferedDataTable;
import org.knime.core.node.port.PortType;
import org.knime.core.node.port.inactive.InactiveBranchPortObject;
import org.knime.core.node.workflow.NodeContainer;
import org.knime.core.node.workflow.WorkflowManager;

import com.ben47203.knimecli.server.api.Endpoint;
import com.ben47203.knimecli.server.api.NodeEndpoint;
import com.ben47203.knimecli.server.api.NodeEndpoint.NodeRef;
import com.ben47203.knimecli.server.api.NodeIds;
import com.ben47203.knimecli.server.api.NodeStates;
import com.ben47203.knimecli.server.api.Requests;
import com.ben47203.knimecli.server.http.LocalApiServer.ApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;

/**
 * The rows of a table on an executed node's output port, a page at a time. Read-only: it reads the table the node
 * already holds and never configures or executes anything, so an unexecuted node is an error, not an empty table.
 */
public final class TableApi {

    /** Rows returned when the request gives no {@code limit}. */
    static final int DEFAULT_LIMIT = 1000;

    /** Most rows one request may ask for. */
    static final int MAX_LIMIT = 1_000_000;

    /** Most cells (rows × columns) in one response, so a wide table can't build a response that exhausts the heap. */
    static final long MAX_CELLS = 5_000_000;

    /** Most column names listed in an "unknown column" error. */
    private static final int MAX_LISTED_COLUMNS = 200;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private TableApi() {
    }

    public static List<Endpoint<?>> endpoints() {
        return List.of(new GetTable());
    }

    /**
     * Request for a page of one output port's table. {@code port} is numbered as in {@code node/ports}: 0 is the
     * flow-variable port, so data ports start at 1, except on a metanode, which has no flow-variable port.
     * {@code columns} picks columns by name, in the order given.
     */
    public record TableRequest(String projectId, String workflowId, String nodeId, Integer port, Long offset,
        Integer limit, List<String> columns) implements NodeRef {
        public TableRequest {
            Requests.require(projectId, "projectId");
            Requests.require(nodeId, "nodeId");
            Requests.require(port, "port");
            if (offset != null && offset < 0) {
                throw new IllegalArgumentException("offset can't be negative");
            }
            if (limit != null && (limit < 0 || limit > MAX_LIMIT)) {
                throw new IllegalArgumentException(
                    "limit is 0 to " + MAX_LIMIT + " rows; page through bigger tables with offset");
            }
            if (columns != null) {
                if (columns.isEmpty()) {
                    throw new IllegalArgumentException("columns can't be empty; leave it out to get every column");
                }
                for (var c : columns) {
                    Requests.require(c, "columns entry");
                }
                columns = List.copyOf(columns);
            }
        }
    }

    /**
     * {@code POST /api/node/table}: {@code limit} rows (default {@value #DEFAULT_LIMIT}) of the table on an output
     * port, from row {@code offset} (default 0), with {@code totalRows}. An offset at or past the end gives no rows.
     *
     * <p>
     * Cells: numbers as JSON numbers (doubles at full precision; NaN and the infinities as the strings
     * {@code "NaN"}, {@code "Infinity"}, {@code "-Infinity"}), booleans as booleans, missing cells as null, anything
     * else as its text.
     *
     * <p>
     * Errors: 400 for a port the node doesn't have (listing its output ports), a port that isn't a table port, an
     * unknown column (listing the available ones) or a page over {@value #MAX_CELLS} cells; 409 if the port holds no
     * table yet (not executed, with the node's state, or on an inactive branch) or the table changed while it was
     * read.
     *
     * <p>
     * Only the port lookup holds the workflow lock; the rows are read without it, so a large read doesn't block the
     * UI. A reset during the read is detected afterwards and reported as a 409 rather than returning cleared rows.
     */
    static final class GetTable extends NodeEndpoint<TableRequest> {
        GetTable() {
            super("node/table", Tier.READ, TableRequest.class);
        }

        @Override
        protected Object execute(final WorkflowManager wfm, final NodeContainer nc, final TableRequest request)
            throws ApiException {
            var index = request.port();
            var table = lookUp(wfm, nc, index);
            var spec = table.getDataTableSpec();
            var columns = columnIndices(spec, request.columns(), nc, index);
            var total = table.size();
            var offset = request.offset() == null ? 0L : request.offset();
            var limit = request.limit() == null ? DEFAULT_LIMIT : request.limit();
            var count = offset >= total ? 0L : Math.min(limit, total - offset);
            if (count * columns.length > MAX_CELLS) {
                throw new ApiException(400, "That page is " + count + " rows by " + columns.length + " columns; a "
                    + "request can't exceed " + MAX_CELLS + " cells, so lower limit or name fewer columns");
            }

            var res = JSON.objectNode();
            res.put("nodeId", NodeIds.toId(nc));
            res.put("port", index);
            res.put("totalRows", total);
            res.put("offset", offset);
            res.putNull("returned"); // filled in below, after the read; keeps its place before the columns
            var cols = res.putArray("columns");
            for (var c : columns) {
                var col = spec.getColumnSpec(c);
                cols.addObject().put("name", col.getName()).put("type", col.getType().getName());
            }
            var rows = res.putArray("rows");
            if (count > 0) {
                try {
                    readRows(table, offset, count, columns, rows);
                } catch (RuntimeException e) { // NOSONAR: rethrown unless the table was cleared under us
                    if (nc.getOutPort(index).getPortObject() == table) {
                        throw e;
                    }
                    throw changed(nc, index);
                }
                // A reset during the read clears the table; without this check its rows could come back as missing.
                if (nc.getOutPort(index).getPortObject() != table) {
                    throw changed(nc, index);
                }
            }
            res.put("returned", rows.size());
            return res;
        }
    }

    /**
     * The table on output port {@code index}, or the reason there is none. One lock hold, so the port's type, object
     * and the node's state come from the same moment.
     */
    @SuppressWarnings("try") // the lock is held, not used
    private static BufferedDataTable lookUp(final WorkflowManager wfm, final NodeContainer nc, final int index)
        throws ApiException {
        try (var lock = wfm.lock()) {
            if (index < 0 || index >= nc.getNrOutPorts()) {
                throw new ApiException(400, "No output port " + index + " on " + describe(nc)
                    + "; its output ports are " + outputPorts(nc) + (nc instanceof WorkflowManager
                        ? ". A metanode has no flow-variable port, so its ports start at 0"
                        : ". Port 0 is the flow-variable port, so data ports start at 1"));
            }
            var port = nc.getOutPort(index);
            var object = port.getPortObject();
            if (object instanceof BufferedDataTable table) {
                return table;
            }
            var type = port.getPortType();
            if (!isTable(type)) {
                throw new ApiException(400, "Output port " + index + " of " + describe(nc) + " is a " + type.getName()
                    + " port, not a table port"
                    + (index == 0 && !(nc instanceof WorkflowManager) ? " (port 0 is the flow-variable port)" : "")
                    + "; its output ports are " + outputPorts(nc));
            }
            if (port.isInactive() || object instanceof InactiveBranchPortObject) {
                throw new ApiException(409, "Output port " + index + " of " + describe(nc)
                    + " is on an inactive branch, so it holds no table");
            }
            throw new ApiException(409, "Output port " + index + " of " + describe(nc)
                + " holds no table until the node executes (it is " + NodeStates.state(nc) + ")");
        }
    }

    private static boolean isTable(final PortType type) {
        return BufferedDataTable.class.isAssignableFrom(type.getPortObjectClass());
    }

    /** Reads rows {@code offset} to {@code offset + count - 1}, materialising only the requested columns. */
    private static void readRows(final BufferedDataTable table, final long offset, final long count,
        final int[] columns, final ArrayNode rows) {
        var filter = new TableFilter.Builder().withFromRowIndex(offset).withToRowIndex(offset + count - 1);
        if (columns.length > 0) {
            filter.withMaterializeColumnIndices(columns);
        }
        try (var it = table.filter(filter.build()).iterator()) {
            while (it.hasNext() && rows.size() < count) {
                var row = it.next();
                var json = rows.addObject();
                json.put("rowId", row.getKey().getString());
                var cells = json.putArray("cells");
                for (var c : columns) {
                    cells.add(cell(row.getCell(c)));
                }
            }
        }
    }

    /**
     * Indices of the requested columns in the order given, duplicates dropped; every column if none were named. 400
     * naming the unknown ones and listing the available ones.
     */
    private static int[] columnIndices(final DataTableSpec spec, final List<String> names, final NodeContainer nc,
        final int index) throws ApiException {
        if (names == null) {
            var all = new int[spec.getNumColumns()];
            for (var i = 0; i < all.length; i++) {
                all[i] = i;
            }
            return all;
        }
        var unknown = new ArrayList<String>();
        var seen = new HashSet<Integer>();
        var picked = new ArrayList<Integer>();
        for (var name : names) {
            var i = spec.findColumnIndex(name);
            if (i < 0) {
                unknown.add("'" + name + "'");
            } else if (seen.add(i)) {
                picked.add(i);
            }
        }
        if (!unknown.isEmpty()) {
            throw new ApiException(400, "Unknown column(s) " + String.join(", ", unknown) + " on output port "
                + index + " of " + describe(nc) + "; available: " + columnNames(spec));
        }
        var result = new int[picked.size()];
        for (var i = 0; i < result.length; i++) {
            result[i] = picked.get(i);
        }
        return result;
    }

    private static String columnNames(final DataTableSpec spec) {
        var n = spec.getNumColumns();
        var names = new ArrayList<String>();
        for (var i = 0; i < Math.min(n, MAX_LISTED_COLUMNS); i++) {
            names.add("'" + spec.getColumnSpec(i).getName() + "'");
        }
        var listed = n == 0 ? "none (the table has no columns)" : String.join(", ", names);
        return n > MAX_LISTED_COLUMNS ? listed + " and " + (n - MAX_LISTED_COLUMNS) + " more" : listed;
    }

    /** {@code 0 Variable Outport (Flow Variable), 1 Filtered table (Table)}: index, name if any, and type. */
    private static String outputPorts(final NodeContainer nc) {
        var parts = new ArrayList<String>();
        for (var i = 0; i < nc.getNrOutPorts(); i++) {
            var port = nc.getOutPort(i);
            var name = port.getPortName();
            parts.add(i + (name == null || name.isBlank() ? "" : " " + name) + " (" + port.getPortType().getName()
                + ")");
        }
        return parts.isEmpty() ? "none" : String.join(", ", parts);
    }

    private static String describe(final NodeContainer nc) {
        return NodeIds.toId(nc) + " (" + nc.getName() + ")";
    }

    private static ApiException changed(final NodeContainer nc, final int index) {
        return new ApiException(409, "The table on output port " + index + " of " + describe(nc)
            + " changed while it was read (the node was reset or re-executed); read it again");
    }

    /**
     * A cell as JSON. Booleans first, since a BooleanCell is also an IntValue and a DoubleValue; then ints and longs as
     * integers, and other numbers as doubles, which Jackson writes in the shortest form that reads back exactly.
     */
    static JsonNode cell(final DataCell cell) {
        if (cell == null || cell.isMissing()) {
            return JSON.nullNode();
        } else if (cell instanceof BooleanValue v) {
            return JSON.booleanNode(v.getBooleanValue());
        } else if (cell instanceof IntValue v) {
            return JSON.numberNode(v.getIntValue());
        } else if (cell instanceof LongValue v) {
            return JSON.numberNode(v.getLongValue());
        } else if (cell instanceof DoubleValue v) {
            return number(v.getDoubleValue());
        }
        return JSON.textNode(cell.toString());
    }

    /** A double as a JSON number, or NaN and the infinities as strings, since JSON has no literal for them. */
    static JsonNode number(final double d) {
        if (Double.isNaN(d)) {
            return JSON.textNode("NaN");
        } else if (Double.isInfinite(d)) {
            return JSON.textNode(d > 0 ? "Infinity" : "-Infinity");
        }
        return JSON.numberNode(d);
    }
}
