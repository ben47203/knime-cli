/**
 * Table rows from output ports: /api/node/table. Builds a CSV Reader (read before and after it runs) and a metanode
 * collapsed around a second, executed reader. Teardown removes them all.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import type { ExecResult, SetResult, WorkflowRead } from "./helpers/types.ts";
import { FACTORIES, WorkflowBuilder } from "./helpers/workflow.ts";

const CSV_READER = "org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory";
// Row 2 has a missing score; row 3's name needs CSV quoting; the scores need all 17 significant digits.
const CSV = 'name,age,score\nAlice,30,0.8731256401927364\nBob,41,\n"Cara, ""C""",25,0.30000000000000004\nDan,52,1e-300\n';

type Cell = string | number | boolean | null;
interface TablePage {
  nodeId: string;
  port: number;
  totalRows: number;
  offset: number;
  returned: number;
  columns: { name: string; type: string }[];
  rows: { rowId: string; cells: Cell[] }[];
}

const fx: Fixture = await connect();
let wf: WorkflowBuilder;
let dir: string;
let csv: string;
let reader: string;

async function addReader(row: number): Promise<string> {
  const id = await wf.addNode(CSV_READER, row);
  await fx.client.api<SetResult>("/api/node/settings/set", {
    ...fx.target,
    nodeId: id,
    model: { csvReaderParameters: { multiFileSelectionParams: { source: { path: { path: csv } } } } },
  });
  return id;
}

async function execute(nodeId: string, target: Record<string, unknown> = fx.target): Promise<void> {
  const ran = await fx.client.api<ExecResult>("/api/execute", { ...target, nodeIds: [nodeId], waitMs: 30_000 });
  assert.equal(ran.states[nodeId], "EXECUTED", JSON.stringify(ran.failed));
}

function table(nodeId: string, extra: Record<string, unknown> = {}): Promise<TablePage> {
  return fx.client.api<TablePage>("/api/node/table", { ...fx.target, nodeId, port: 1, ...extra });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knime-cli-table-"));
  csv = join(dir, "people.csv");
  await writeFile(csv, CSV);
  wf = new WorkflowBuilder(fx);
  reader = await addReader(0);
});

after(async () => {
  try {
    await wf?.teardown();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("before the reader runs", () => {
  test("409 naming the node's state, not an empty table, and nothing executes", async () => {
    await expectHttpError(table(reader), 409, "holds no table until the node executes", "CONFIGURED");
    await expectHttpError(table(reader), 409, "CONFIGURED"); // still not executed: reading ran nothing
  });
});

describe("once the reader has run", () => {
  before(async () => execute(reader));

  test("the whole table: columns, types, row ids and cells at full precision", async () => {
    const t = await table(reader);
    assert.deepEqual([t.nodeId, t.port, t.totalRows, t.offset, t.returned], [reader, 1, 4, 0, 4]);
    assert.deepEqual(t.columns.map((c) => c.name), ["name", "age", "score"]);
    assert.equal(t.columns[0]?.type, "String");
    assert.match(t.columns[1]?.type ?? "", /Integer/);
    assert.match(t.columns[2]?.type ?? "", /Float|Double/i);
    assert.deepEqual(t.rows[0]?.cells, ["Alice", 30, 0.8731256401927364]);
    assert.deepEqual(t.rows[1]?.cells, ["Bob", 41, null]);
    assert.deepEqual(t.rows[2]?.cells, ['Cara, "C"', 25, 0.30000000000000004]);
    assert.equal(t.rows[3]?.cells[2], 1e-300);
    assert.equal(new Set(t.rows.map((r) => r.rowId)).size, 4);
  });

  test("offset and limit page through it; an offset past the end gives no rows", async () => {
    const all = await table(reader);
    const page = await table(reader, { offset: 1, limit: 2 });
    assert.deepEqual([page.offset, page.returned, page.totalRows], [1, 2, 4]);
    assert.deepEqual(page.rows, all.rows.slice(1, 3));
    const past = await table(reader, { offset: 99 });
    assert.deepEqual([past.totalRows, past.returned, past.rows], [4, 0, []]);
    const none = await table(reader, { limit: 0 });
    assert.deepEqual([none.returned, none.columns.length], [0, 3]);
  });

  test("columns picks a subset in the given order; an unknown one lists the available ones", async () => {
    const t = await table(reader, { columns: ["score", "name", "score"] });
    assert.deepEqual(t.columns.map((c) => c.name), ["score", "name"]);
    assert.deepEqual(t.rows[0]?.cells, [0.8731256401927364, "Alice"]);
    await expectHttpError(table(reader, { columns: ["nope"] }), 400, "Unknown column(s) 'nope'", "available: 'name', 'age', 'score'");
  });

  test("port 0 isn't a table port; a port it doesn't have lists its ports", async () => {
    await expectHttpError(table(reader, { port: 0 }), 400, "not a table port", "Flow Variable");
    await expectHttpError(table(reader, { port: 5 }), 400, "No output port 5", "its output ports are 0", "1");
  });

  test("bad requests are 400s", async () => {
    await expectHttpError(table(reader, { offset: -1 }), 400, "offset can't be negative");
    await expectHttpError(table(reader, { limit: 1_000_001 }), 400, "limit is 0 to 1000000");
    await expectHttpError(table(reader, { columns: [] }), 400, "columns can't be empty");
    await expectHttpError(fx.client.api("/api/node/table", { ...fx.target, nodeId: reader }), 400, "port is required");
    await expectHttpError(table("root:99999"), 404);
  });
});

describe("metanode", () => {
  test("its own output port 0, and the node inside it by workflowId", { timeout: 60_000 }, async () => {
    // Collapsing gives the metanode a port per connection crossing its border, so the reader needs a successor.
    const inner = await addReader(1);
    const downstream = await wf.addNode(FACTORIES.COLUMN_FILTER, 1);
    await wf.connect(inner, 1, downstream, 1);
    const meta = await wf.collapse([inner]);
    await execute(meta);
    const outer = await table(meta, { port: 0 });
    assert.deepEqual([outer.nodeId, outer.port, outer.totalRows], [meta, 0, 4]);
    await expectHttpError(table(meta, { port: 1 }), 400, "A metanode has no flow-variable port");

    const inside = await fx.client.api<WorkflowRead>("/api/workflow", { ...fx.target, workflowId: meta });
    const innerId = Object.keys(inside.workflow.nodes ?? {})[0];
    assert.ok(innerId, "the metanode has a node inside");
    const t = await fx.client.api<TablePage>("/api/node/table", { ...fx.target, workflowId: meta, nodeId: innerId, port: 1 });
    assert.deepEqual(t.rows, outer.rows);
  });
});
