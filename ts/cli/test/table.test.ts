import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HttpError } from "../../src/client.ts";
import { byAlias } from "../catalogue.ts";
import { main, type Io } from "../cli.ts";
import { COMMANDS } from "../commands/index.ts";
import { csvCell, parseColumns, parseCsvLine, parseLimit, toCsv, type Cell, type TableColumn } from "../commands/table.ts";
import { EXIT, translate } from "../errors.ts";
import { errorTable } from "../guide.ts";
import { FakeKnime } from "./fake.ts";

interface FakeTable {
  columns: TableColumn[];
  rows: { rowId: string; cells: Cell[] }[];
}

/** FakeKnime plus `/api/node/table` and `/api/node/ports`, with the plugin's error texts. */
class TableKnime extends FakeKnime {
  /** Tables by `nodeId:port`; a port listed in `models` is a model port. */
  tables = new Map<string, FakeTable>();
  models = new Set<string>();

  override async api<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    if (path !== "/api/node/table" && path !== "/api/node/ports") return super.api<T>(path, body);
    this.calls.push({ method: path, body });
    const n = this.nodes.get(String(body.nodeId));
    if (!n) throw new HttpError(404, `No node ${String(body.nodeId)} in this workflow`);
    const type = (i: number) => (this.tables.has(`${n.id}:${i}`) ? "Table" : i === 0 ? "Flow Variable" : this.models.has(`${n.id}:${i}`) ? "PMML" : "Table");
    if (path === "/api/node/ports") {
      return { nodeId: n.id, inputs: [], outputs: Array.from({ length: n.outPorts }, (_, index) => ({ index, name: `out${index}`, type: type(index) })) } as T;
    }
    const port = Number(body.port);
    const desc = `${n.id} (${n.name})`;
    const list = Array.from({ length: n.outPorts }, (_, i) => `${i} out${i} (${type(i)})`).join(", ");
    if (port < 0 || port >= n.outPorts) throw new HttpError(400, `No output port ${port} on ${desc}; its output ports are ${list}. Port 0 is the flow-variable port, so data ports start at 1`);
    if (type(port) !== "Table") throw new HttpError(400, `Output port ${port} of ${desc} is a ${type(port)} port, not a table port; its output ports are ${list}`);
    if (n.state !== "EXECUTED") throw new HttpError(409, `Output port ${port} of ${desc} holds no table until the node executes (it is ${n.state})`);
    const t = this.tables.get(`${n.id}:${port}`) ?? { columns: [], rows: [] };
    const names = body.columns as string[] | undefined;
    let idx = t.columns.map((_, i) => i);
    if (names) {
      const unknown = names.filter((c) => !t.columns.some((x) => x.name === c));
      if (unknown.length) throw new HttpError(400, `Unknown column(s) ${unknown.map((u) => `'${u}'`).join(", ")} on output port ${port} of ${desc}; available: ${t.columns.map((c) => `'${c.name}'`).join(", ")}`);
      idx = names.map((c) => t.columns.findIndex((x) => x.name === c));
    }
    const offset = Number(body.offset ?? 0);
    const limit = Number(body.limit ?? 1000);
    if (limit > 1_000_000) throw new HttpError(400, "limit is 0 to 1000000 rows; page through bigger tables with offset");
    const rows = t.rows.slice(offset, offset + limit).map((r) => ({ rowId: r.rowId, cells: idx.map((i) => r.cells[i]!) }));
    return { nodeId: n.id, port, totalRows: t.rows.length, offset, returned: rows.length, columns: idx.map((i) => t.columns[i]!), rows } as T;
  }

  tableCalls(): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === "/api/node/table").map((c) => c.body);
  }
}

function workflow(rows = 3): TableKnime {
  const k = new TableKnime();
  const reader = k.add({ factory: byAlias("csv-reader")!.factory, label: "my:reader", inPorts: 1, state: "EXECUTED" });
  const learner = k.add({ factory: byAlias("rf-learn")!.factory, label: "my:learn", outPorts: 4, state: "EXECUTED" });
  k.add({ factory: byAlias("partition")!.factory, label: "my:part" }); // CONFIGURED, never run
  k.connect(reader.id, 1, learner.id, 1);
  k.models.add(`${learner.id}:3`);
  k.tables.set(`${reader.id}:1`, {
    columns: [{ name: "Churned", type: "String" }, { name: "P (Churned=1)_gbt1", type: "Number (Float)" }, { name: "n", type: "Number (Integer)" }],
    rows: Array.from({ length: rows }, (_, i) => ({ rowId: `Row${i}`, cells: [String(i % 2), i === 1 ? null : 0.8731256401927364 + i, i] })),
  });
  return k;
}

async function knime(k: FakeKnime, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), connect: async () => k.session() };
  const code = await main(COMMANDS, argv, io);
  return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

test("node table --json gives the plugin's page in the envelope, numbers at full precision", async () => {
  const r = await knime(workflow(), "node", "table", "my:reader", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.command, "node table");
  const d = r.json.data;
  assert.deepEqual({ nodeId: d.nodeId, port: d.port, totalRows: d.totalRows, offset: d.offset, returned: d.returned },
    { nodeId: "root:1", port: 1, totalRows: 3, offset: 0, returned: 3 });
  assert.deepEqual(d.columns[1], { name: "P (Churned=1)_gbt1", type: "Number (Float)" });
  assert.deepEqual(d.rows[0], { rowId: "Row0", cells: ["0", 0.8731256401927364, 0] });
  assert.equal(d.rows[1].cells[1], null);
});

test("node table prints valid JSON, one row per line, without --json", async () => {
  const r = await knime(workflow(), "node", "table", "my:reader");
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 5); // head, 3 rows, closing
  assert.match(lines[1]!, /^\{"rowId":"Row0"/);
  assert.equal(JSON.parse(r.stdout).rows.length, 3);
  assert.match(r.stderr, /3 of 3 row\(s\) from root:1 \[my:reader\]:1/);
  const empty = await knime(workflow(0), "node", "table", "my:reader");
  assert.deepEqual(JSON.parse(empty.stdout).rows, []);
});

test("node:port parses with labels that contain colons; the port defaults to 1", async () => {
  const k = workflow();
  k.tables.set("root:2:2", { columns: [{ name: "x", type: "String" }], rows: [{ rowId: "r", cells: ["a"] }] });
  for (const [ref, nodeId, port] of [["my:reader", "root:1", 1], ["my:reader:1", "root:1", 1], ["root:2:2", "root:2", 2], ["2:2", "root:2", 2], ["my:learn:2", "root:2", 2]] as const) {
    const r = await knime(k, "node", "table", ref, "--json");
    assert.equal(r.code, 0, ref);
    assert.deepEqual([r.json.data.nodeId, r.json.data.port], [nodeId, port], ref);
  }
});

test("a metanode's port defaults to 0, since it has no flow-variable port", async () => {
  const k = workflow();
  const meta = k.add({ factory: "metanode", label: "my:meta", outPorts: 1, state: "EXECUTED" });
  k.tables.set(`${meta.id}:0`, { columns: [{ name: "x", type: "String" }], rows: [{ rowId: "r", cells: ["a"] }] });
  const kind = k.api.bind(k);
  k.api = async <T>(path: string, body: Record<string, unknown> = {}): Promise<T> => {
    const r = await kind<T>(path, body);
    if (path === "/api/workflow") (r as { workflow: { nodes: Record<string, { kind?: string }> } }).workflow.nodes[meta.id]!.kind = "metanode";
    return r;
  };
  const r = await knime(k, "node", "table", "my:meta", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.json.data.port, 0);
  assert.equal((await knime(k, "node", "table", "my:meta:1", "--json")).json.error.code, "PORT_OUT_OF_RANGE");
});

test("--columns picks and orders columns, with CSV quoting for names with commas", async () => {
  const r = await knime(workflow(), "node", "table", "my:reader", "--columns", "n,Churned", "--json");
  assert.deepEqual(r.json.data.columns.map((c: TableColumn) => c.name), ["n", "Churned"]);
  assert.deepEqual(r.json.data.rows[2].cells, [2, "0"]);
  assert.deepEqual(parseColumns(['"a,b",c', "d", "c"]), ["a,b", "c", "d"]);
  assert.deepEqual(parseCsvLine('x,"say ""hi""",'), ["x", 'say "hi"', ""]);
  assert.throws(() => parseColumns(["a,,b"]), /empty column name/);
  assert.throws(() => parseCsvLine('"open'), /Unclosed quote/);
});

test("--csv writes RowID first, RFC 4180 quoting, full-precision numbers and empty missing values", async () => {
  const r = await knime(workflow(), "node", "table", "my:reader", "--csv");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, [
    "RowID,Churned,P (Churned=1)_gbt1,n",
    "Row0,0,0.8731256401927364,0",
    "Row1,1,,1",
    "Row2,0,2.8731256401927365,2",
    "",
  ].join("\n"));
  const csv = toCsv({
    columns: [{ name: 'a,"b"', type: "String" }, { name: "x", type: "Number (Float)" }, { name: "f", type: "Boolean" }],
    rows: [{ rowId: "r\n1", cells: ['he said "no", then\r\nleft', 0.1 + 0.2, true] }, { rowId: " r2", cells: ["NaN", 1e-300, null] }],
  });
  assert.equal(csv, 'RowID,"a,""b""",x,f\n"r\n1","he said ""no"", then\r\nleft",0.30000000000000004,true\n" r2",NaN,1e-300,\n');
  for (const v of [0.8731256401927364, 1 / 3, 2 ** 53 + 2, 5e-324, -1.5e300]) assert.equal(Number(csvCell(v)), v);
});

test("--limit all pages through the table and joins the pages", async () => {
  const k = workflow(120_123);
  const r = await knime(k, "node", "table", "my:reader", "--limit", "all", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.json.data.returned, 120_123);
  assert.equal(r.json.data.rows.length, 120_123);
  assert.equal(r.json.data.rows[120_122].rowId, "Row120122");
  const calls = k.tableCalls();
  assert.deepEqual(calls.map((c) => [c.offset, c.limit]), [[0, 0], [0, 50_000], [50_000, 50_000], [100_000, 20_123]]);
});

test("--limit all from an offset, wide tables get shorter pages, and an offset past the end gives no rows", async () => {
  const k = workflow(10);
  const wide = Array.from({ length: 200_000 }, (_, i) => ({ name: `c${i}`, type: "String" }));
  k.tables.set("root:2:1", { columns: wide, rows: Array.from({ length: 25 }, (_, i) => ({ rowId: `R${i}`, cells: wide.map(() => "v") })) });
  const r = await knime(k, "node", "table", "my:learn", "--limit", "all", "--offset", "3", "--json");
  assert.equal(r.json.data.returned, 22);
  assert.deepEqual(k.tableCalls().slice(1).map((c) => c.limit), [10, 10, 2]); // 2,000,000 cells / 200,000 columns
  const past = await knime(k, "node", "table", "my:reader", "--offset", "50", "--json");
  assert.equal(past.code, 0);
  assert.deepEqual([past.json.data.totalRows, past.json.data.returned, past.json.data.rows], [10, 0, []]);
  assert.match(past.json.warnings[0], /past the end: the table has 10 row/);
  const zero = await knime(k, "node", "table", "my:reader", "--limit", "0", "--json");
  assert.deepEqual([zero.json.data.columns.length, zero.json.data.rows.length], [3, 0]);
});

test("-o writes the file and reports the path and row count, not the rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "knime-table-"));
  try {
    const file = join(dir, "rows.csv");
    const r = await knime(workflow(), "node", "table", "my:reader", "--csv", "-o", file, "--json");
    assert.equal(r.code, 0);
    assert.deepEqual([r.json.data.file, r.json.data.format, r.json.data.returned, r.json.data.rows], [file, "csv", 3, undefined]);
    assert.match(await readFile(file, "utf8"), /^RowID,Churned/);
    const human = await knime(workflow(), "node", "table", "my:reader", "-o", join(dir, "rows.json"));
    assert.equal(human.stdout, "");
    assert.match(human.stderr, /wrote 3 of 3 row\(s\) from root:1:1 to .*rows\.json/);
    assert.equal(JSON.parse(await readFile(join(dir, "rows.json"), "utf8")).rows.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bad options are usage errors (exit 2) before KNIME is asked", async () => {
  const k = workflow();
  for (const argv of [["--limit", "-1"], ["--limit", "1.5"], ["--limit", "lots"], ["--offset", "-3"], ["--csv", "--json"]]) {
    const r = await knime(k, "node", "table", "my:reader", ...argv, "--json");
    assert.equal(r.code, EXIT.USAGE, argv.join(" "));
    assert.equal(r.json.error.code, "USAGE");
  }
  assert.equal(k.tableCalls().length, 0);
  assert.equal(parseLimit("ALL"), Infinity);
  assert.equal(parseLimit(undefined), 1000);
});

test("an unexecuted node is NODE_NOT_EXECUTED (exit 8) with its state, never an empty table", async () => {
  const r = await knime(workflow(), "node", "table", "my:part", "--json");
  assert.equal(r.code, EXIT.INCOMPLETE);
  assert.equal(r.json.error.code, "NODE_NOT_EXECUTED");
  assert.match(r.json.error.message, /holds no table until the node executes \(it is CONFIGURED\)/);
  assert.match(r.json.error.hint, /knime run/);
  assert.deepEqual(r.json.error.details, { nodeId: "root:3", port: 1, state: "CONFIGURED" });
});

test("a port out of range is PORT_OUT_OF_RANGE, listing the node's ports", async () => {
  const r = await knime(workflow(), "node", "table", "my:learn:7", "--json");
  assert.equal(r.code, EXIT.REJECTED);
  assert.equal(r.json.error.code, "PORT_OUT_OF_RANGE");
  assert.match(r.json.error.message, /its output ports are 0 out0 \(Flow Variable\), 1 out1 \(Table\)/);
  assert.deepEqual(r.json.error.details.outputs.map((p: { index: number; type: string }) => `${p.index}:${p.type}`), ["0:Flow Variable", "1:Table", "2:Table", "3:PMML"]);
});

test("a model or flow-variable port is NOT_A_TABLE, naming the port type", async () => {
  const model = await knime(workflow(), "node", "table", "my:learn:3", "--json");
  assert.equal(model.code, EXIT.REJECTED);
  assert.equal(model.json.error.code, "NOT_A_TABLE");
  assert.match(model.json.error.message, /is a PMML port, not a table port/);
  assert.equal(model.json.error.details.outputs.length, 4);
  const vars = await knime(workflow(), "node", "table", "my:learn:0", "--json");
  assert.equal(vars.json.error.code, "NOT_A_TABLE");
  assert.match(vars.json.error.message, /Flow Variable port/);
});

test("an unknown column is COLUMN_NOT_FOUND (exit 3), with the available columns", async () => {
  const r = await knime(workflow(), "node", "table", "my:reader", "--columns", "Churned,nope", "--json");
  assert.equal(r.code, EXIT.NOT_FOUND);
  assert.equal(r.json.error.code, "COLUMN_NOT_FOUND");
  assert.match(r.json.error.message, /Unknown column\(s\) 'nope'.*available: 'Churned'/);
  assert.deepEqual(r.json.error.details.available.map((c: TableColumn) => c.name), ["Churned", "P (Churned=1)_gbt1", "n"]);
});

test("a table that changes size between pages is TABLE_CHANGED (exit 6)", async () => {
  const k = workflow(60_000);
  let pages = 0;
  const api = k.api.bind(k);
  k.api = async <T>(path: string, body: Record<string, unknown> = {}): Promise<T> => {
    if (path === "/api/node/table" && Number(body.limit) > 0 && ++pages === 2) k.tables.get("root:1:1")!.rows.pop();
    return api<T>(path, body);
  };
  const r = await knime(k, "node", "table", "my:reader", "--limit", "all", "--json");
  assert.equal(r.code, EXIT.CONFLICT);
  assert.equal(r.json.error.code, "TABLE_CHANGED");
});

const serverErrors: [HttpError, string, number][] = [
  [new HttpError(400, "No output port 5 on root:3 (Partitioning); its output ports are 0 Variable Outport (Flow Variable), 1 First partition (Table)"), "PORT_OUT_OF_RANGE", EXIT.REJECTED],
  [new HttpError(400, "Output port 2 of root:4 (Random Forest Learner) is a Tree Ensemble port, not a table port; its output ports are …"), "NOT_A_TABLE", EXIT.REJECTED],
  [new HttpError(400, "Unknown column(s) 'x' on output port 1 of root:3 (Partitioning); available: 'a', 'b'"), "COLUMN_NOT_FOUND", EXIT.NOT_FOUND],
  [new HttpError(409, "Output port 1 of root:3 (Partitioning) is on an inactive branch, so it holds no table"), "TABLE_INACTIVE", EXIT.INCOMPLETE],
  [new HttpError(409, "Output port 1 of root:3 (Partitioning) holds no table until the node executes (it is IDLE)"), "NODE_NOT_EXECUTED", EXIT.INCOMPLETE],
  [new HttpError(409, "The table on output port 1 of root:3 (Partitioning) changed while it was read (the node was reset or re-executed); read it again"), "TABLE_CHANGED", EXIT.CONFLICT],
  [new HttpError(400, "No output port 1 on root:5 (Metanode); its output ports are 0 (Table). A metanode has no flow-variable port, so its ports start at 0"), "PORT_OUT_OF_RANGE", EXIT.REJECTED],
  // Other routes keep their codes.
  [new HttpError(409, "Cannot change settings of root:3: it or a successor is queued or executing"), "BUSY", EXIT.CONFLICT],
  [new HttpError(400, "limit is 0 to 1000000 rows; page through bigger tables with offset"), "BAD_REQUEST", EXIT.REJECTED],
  [new HttpError(400, "offset can't be negative"), "BAD_REQUEST", EXIT.REJECTED],
];

for (const [error, code, exit] of serverErrors) {
  test(`table errors: translates ${code} (${error.message.slice(10, 40)}…)`, () => {
    const t = translate(error);
    assert.equal(t.code, code);
    assert.equal(t.exit, exit);
  });
}

test("the guide's error table lists the table errors, and the tables topic exists", async () => {
  const table = errorTable();
  for (const c of ["PORT_OUT_OF_RANGE", "NOT_A_TABLE", "COLUMN_NOT_FOUND", "TABLE_INACTIVE", "NODE_NOT_EXECUTED", "TABLE_CHANGED"]) assert.ok(table.includes(`**${c}**`), c);
  const r = await knime(new FakeKnime(), "guide", "tables", "--json");
  assert.match(r.json.data.body, /knime node table/);
});
