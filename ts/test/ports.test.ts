/**
 * Node ports and their specs: /api/node/ports. Builds CSV Reader -> Column Filter (once the reader has run, the
 * unexecuted filter's input spec is the reader's output spec), an unconnected Column Filter, a CSV Reader with no file
 * feeding a Column Filter (upstream not configured), and a metanode collapsed from a Table Creator. Teardown removes
 * them all.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import type { ExecResult, NodePorts, PortSpec, SetResult } from "./helpers/types.ts";
import { FACTORIES, nodeStatus, WorkflowBuilder } from "./helpers/workflow.ts";

const CSV_READER = "org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory";
const CSV = "name,age,score,city\nAlice,30,1.5,Perth\nBob,41,2.25,Hobart\nCara,25,3.0,Perth\n";
const COLUMNS = ["name", "age", "score", "city"];

const fx: Fixture = await connect();
let wf: WorkflowBuilder;
let dir: string;
let reader: string;
let filter: string;
let lonely: string;
let emptyReader: string;
let starved: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knime-cli-ports-"));
  const csv = join(dir, "people.csv");
  await writeFile(csv, CSV);

  wf = new WorkflowBuilder(fx);
  reader = await wf.addNode(CSV_READER);
  await fx.client.api<SetResult>("/api/node/settings/set", {
    ...fx.target,
    nodeId: reader,
    model: { csvReaderParameters: { multiFileSelectionParams: { source: { path: { path: csv } } } } },
  });
  filter = await wf.addNode(FACTORIES.COLUMN_FILTER);
  await wf.connect(reader, 1, filter, 1);

  lonely = await wf.addNode(FACTORIES.COLUMN_FILTER, 1);

  emptyReader = await wf.addNode(CSV_READER, 2);
  starved = await wf.addNode(FACTORIES.COLUMN_FILTER, 2);
  await wf.connect(emptyReader, 1, starved, 1);
});

after(async () => {
  try {
    await wf?.teardown();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function ports(nodeId: string): Promise<NodePorts> {
  return fx.client.api<NodePorts>("/api/node/ports", { ...fx.target, nodeId });
}

/** Element `i`, failing clearly if there isn't one. */
function nth<T>(items: T[], i: number): T {
  const item = items[i];
  assert.ok(item !== undefined, `expected at least ${i + 1} item(s), got ${items.length}`);
  return item;
}

function tableSpec(spec: PortSpec | null): Extract<PortSpec, { kind: "table" }> {
  assert.ok(spec, "expected a spec");
  assert.equal(spec.kind, "table", `expected a table spec, got ${JSON.stringify(spec)}`);
  return spec as Extract<PortSpec, { kind: "table" }>;
}

// A CSV Reader whose dialog was never applied configures without an output spec: it only knows its columns once it
// has read the file. So the chain has no table specs until the reader runs, and then the filter, still unexecuted,
// sees them on its input and configures its own output from them.
describe("before the reader runs", () => {
  test("CSV Reader: configured, but no table spec until it executes", async () => {
    const p = await ports(reader);
    assert.equal(p.nodeId, reader);
    assert.equal(p.outputs.length, 2);
    const out = nth(p.outputs, 1);
    assert.equal(out.index, 1);
    assert.equal(out.type, "Table");
    assert.deepEqual(out.connectedTo, [{ nodeId: filter, index: 1 }]);
    assert.equal(out.spec, null);
    assert.equal(out.reason, "no spec until the node executes");
  });

  test("Column Filter: the reader's missing spec, with why", async () => {
    const f = await ports(filter);
    const input = nth(f.inputs, 1);
    assert.equal(input.connected, true);
    assert.deepEqual(input.connectedFrom, { nodeId: reader, index: 1 });
    assert.equal(input.spec, null);
    assert.equal(input.reason, "upstream has no spec until it executes");
    assert.equal(nth(f.outputs, 1).reason, "upstream has no spec until it executes");
  });
});

describe("once the reader has run", () => {
  test("CSV Reader: columns, types and domains", { timeout: 60_000 }, async () => {
    const ran = await fx.client.api<ExecResult>("/api/execute", { ...fx.target, nodeIds: [reader], waitMs: 30_000 });
    assert.equal(ran.states[reader], "EXECUTED", JSON.stringify(ran.failed));
    const out = nth((await ports(reader)).outputs, 1);
    assert.equal(out.reason, undefined);
    const columns = tableSpec(out.spec).columns;
    assert.deepEqual(columns.map((c) => c.name), COLUMNS);
    assert.equal(nth(columns, 0).type, "String");
    assert.match(nth(columns, 1).type, /Integer/);
    const city = columns.find((c) => c.name === "city");
    assert.deepEqual(new Set(city?.domain?.values), new Set(["Perth", "Hobart"]));
    assert.equal(city?.domain?.valuesTruncated, undefined);
    const age = columns.find((c) => c.name === "age");
    assert.equal(age?.domain?.lower, 25);
    assert.equal(age?.domain?.upper, 41);
    assert.match(out.summary ?? "", /3/, "the summary mentions the row count");
  });

  test("Column Filter, not executed: its input spec is the reader's output spec", async () => {
    const [r, f, status] = await Promise.all([ports(reader), ports(filter), nodeStatus(fx.client, fx.target, filter)]);
    assert.equal(status.state, "CONFIGURED");
    const input = nth(f.inputs, 1);
    assert.equal(input.type, "Table");
    assert.deepEqual(input.spec, nth(r.outputs, 1).spec);
    // Its own output comes from configure: every column, as a fresh filter includes them all.
    assert.deepEqual(tableSpec(nth(f.outputs, 1).spec).columns.map((c) => c.name), COLUMNS);
  });
});

describe("flow-variable ports", () => {
  test("port 0 reports its kind and lists no variables, configured or not", async () => {
    for (const nodeId of [reader, filter, lonely, starved]) {
      const p = await ports(nodeId);
      for (const port of [nth(p.inputs, 0), nth(p.outputs, 0)]) {
        assert.equal(port.index, 0);
        assert.equal(port.type, "Flow Variable");
        assert.deepEqual(port.spec, { kind: "flowVariables" }, `${nodeId}: nothing but the kind`);
        assert.equal(port.reason, undefined);
      }
      assert.equal(nth(p.inputs, 0).optional, true);
      assert.equal(nth(p.inputs, 0).connected, false);
    }
  });
});

describe("no spec yet", () => {
  test("an unconnected node: spec null with a reason", async () => {
    const p = await ports(lonely);
    assert.equal(nth(p.inputs, 1).connected, false);
    assert.equal(nth(p.inputs, 1).connectedFrom, undefined);
    assert.equal(nth(p.inputs, 1).spec, null);
    assert.equal(nth(p.inputs, 1).reason, "not connected");
    assert.equal(nth(p.outputs, 1).spec, null);
    assert.equal(nth(p.outputs, 1).reason, "input 1 not connected");
  });

  test("an unconfigured upstream: spec null, upstream not configured", async () => {
    const r = await ports(emptyReader);
    assert.equal(nth(r.outputs, 1).spec, null);
    assert.match(nth(r.outputs, 1).reason ?? "", /^node not configured: /, "the node's own message says why");
    const p = await ports(starved);
    assert.equal(nth(p.inputs, 1).connected, true);
    assert.equal(nth(p.inputs, 1).spec, null);
    assert.equal(nth(p.inputs, 1).reason, "upstream not configured");
    assert.equal(nth(p.outputs, 1).spec, null);
    assert.equal(nth(p.outputs, 1).reason, "upstream not configured");
  });
});

describe("metanode", () => {
  test("ports are the metanode's own, with no implicit flow-variable port", async () => {
    // Collapsing gives the metanode a port per connection crossing its border, so the creator needs a successor.
    const tc = await wf.addNode(FACTORIES.TABLE_CREATOR, 3);
    const downstream = await wf.addNode(FACTORIES.COLUMN_FILTER, 3);
    await wf.connect(tc, 1, downstream, 1);
    const meta = await wf.collapse([tc]);
    const p = await ports(meta);
    assert.equal(p.nodeId, meta);
    assert.deepEqual(p.inputs, []);
    assert.equal(p.outputs.length, 1);
    assert.equal(nth(p.outputs, 0).type, "Table");
    assert.deepEqual(nth(p.outputs, 0).connectedTo, [{ nodeId: downstream, index: 1 }]);
    tableSpec(nth(p.outputs, 0).spec); // the Table Creator's default table, which has no columns yet
    assert.deepEqual(nth((await ports(downstream)).inputs, 1).spec, nth(p.outputs, 0).spec, "the successor sees the same spec");
  });
});

describe("errors", () => {
  test("invalid nodeId -> 400; unknown -> 404; missing -> 400", async () => {
    await expectHttpError(ports("root:x"), 400, "nodeId");
    await expectHttpError(ports("garbage"), 400, "nodeId");
    await expectHttpError(ports("root:99999"), 404);
    await expectHttpError(fx.client.api("/api/node/ports", fx.target), 400, "nodeId is required");
  });
});
