import assert from "node:assert/strict";
import { test } from "node:test";

import { byAlias, search } from "../catalogue.ts";
import { findCommand, helpFor, main, type Io } from "../cli.ts";
import { COMMANDS } from "../commands/index.ts";
import { EXIT } from "../errors.ts";
import { findTopic, loadTopics } from "../guide.ts";
import { pickInstance } from "../session.ts";
import { FakeKnime } from "./fake.ts";

async function knime(k: FakeKnime, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), connect: async () => k.session() };
  const code = await main(COMMANDS, argv, io);
  return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

function workflow(): FakeKnime {
  const k = new FakeKnime();
  const a = k.add({ factory: byAlias("csv-reader")!.factory, label: "my:reader", inPorts: 1, model: { seed: 1, name: "a" } });
  const b = k.add({ factory: byAlias("partition")!.factory, label: "my:part", outPorts: 3, model: { percentage: 70 } });
  k.add({ factory: byAlias("partition")!.factory });
  k.connect(a.id, 1, b.id, 1);
  return k;
}

test("findCommand matches the longest path and skips global options before it", () => {
  assert.deepEqual(findCommand(COMMANDS, ["node", "set", "x", "a=1"]).command?.path, ["node", "set"]);
  const r = findCommand(COMMANDS, ["--pid", "7", "workflow", "show", "--json"]);
  assert.deepEqual(r.command?.path, ["workflow", "show"]);
  assert.deepEqual(r.rest, ["--pid", "7", "--json"]);
  assert.equal(findCommand(COMMANDS, ["nope"]).command, undefined);
});

test("every command's help shows its tier", () => {
  for (const c of COMMANDS) assert.match(helpFor(c), /Tier: (LOCAL|READ|WRITE|EXEC)/);
});

test("pickInstance prefers --pid, then the newest", () => {
  const inst = (pid: number) => ({ pid, apiVersion: 2, knimeVersion: "", port: 1, url: "", token: "", startedAt: "", file: "" });
  assert.equal(pickInstance([inst(2), inst(1)]).pid, 2);
  assert.equal(pickInstance([inst(2), inst(1)], "1").pid, 1);
  assert.throws(() => pickInstance([inst(2)], "9"), /No running KNIME instance with pid 9/);
});

test("guide topics come from CONTEXT.md and errors include the generated table", () => {
  const topics = loadTopics();
  for (const id of ["start", "model", "settings", "execution", "errors", "recipes", "apply"]) assert.ok(findTopic(topics, id), id);
  assert.equal(findTopic(topics, "ports")?.id, "model");
  assert.match(findTopic(topics, "errors")!.body, /GATEWAY_TIMEOUT/);
});

test("catalogue search ranks aliases first, and every entry is well formed", () => {
  assert.equal(search("regression")[0]?.alias.includes("reg"), true);
  assert.equal(search("forest")[0]?.alias, "rf-learn");
  for (const e of [byAlias("rf-learn")!, byAlias("reg-predict")!]) assert.ok(e.factory.endsWith("Factory") || /Factory\d*$/.test(e.factory));
});

test("unknown commands and bad options are usage errors (exit 2), with JSON on stdout", async () => {
  const k = workflow();
  assert.equal((await knime(k, "frobnicate")).code, EXIT.USAGE);
  const r = await knime(k, "workflow", "show", "--nope", "--json");
  assert.equal(r.code, EXIT.USAGE);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, "USAGE");
});

test("workflow show lists nodes with labels, and notes which project it picked", async () => {
  const r = await knime(workflow(), "workflow", "show", "--json");
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.data.nodes.map((n: { label?: string }) => n.label), ["my:reader", "my:part", undefined]);
  assert.deepEqual(r.json.data.connections.map((c: { from: string }) => c.from), ["root:1:1"]);
  assert.match(r.json.notes[0], /project "Test"/);
});

test("nodes resolve by label, id or bare number; unknown ones exit 3", async () => {
  const k = workflow();
  for (const ref of ["my:part", "root:2", "2"]) {
    const r = await knime(k, "node", "settings", ref, "--json");
    assert.equal(r.json.data.nodeId, "root:2", ref);
  }
  assert.equal((await knime(k, "node", "settings", "nope")).code, EXIT.NOT_FOUND);
});

test("node settings prints dot-paths", async () => {
  const r = await knime(workflow(), "node", "settings", "my:reader");
  assert.match(r.stdout, /^seed = 1$/m);
  assert.match(r.stdout, /^name = "a"$/m);
});

test("node set --dry-run shows the diff and what resets, and sends nothing", async () => {
  const k = workflow();
  const r = await knime(k, "node", "set", "my:reader", "seed=5", "--dry-run");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /~ seed: 1 → 5/);
  assert.match(r.stderr, /would reset root:1 and 1 downstream node\(s\); settings changes can't be undone/);
  assert.ok(!k.calls.some((c) => c.method === "/api/node/settings/set"));
});

test("node set sends the patch and warns about the reset", async () => {
  const k = workflow();
  const r = await knime(k, "node", "set", "my:reader", "seed=5", "--json");
  assert.equal(r.json.data.changed, true);
  assert.deepEqual(r.json.data.resets, ["root:1", "root:2"]);
  assert.equal(k.nodes.get("root:1")!.model.seed, 5);
});

test("an unknown setting comes back translated (exit 7)", async () => {
  const r = await knime(workflow(), "node", "set", "my:reader", "bogus=1", "--json");
  assert.equal(r.code, EXIT.REJECTED);
  assert.equal(r.json.error.code, "UNKNOWN_SETTING");
  assert.match(r.json.error.hint, /knime node settings/);
});

test("node rm refuses unlabelled nodes without --force, and short prefixes always", async () => {
  const k = workflow();
  assert.equal((await knime(k, "node", "rm", "root:3")).code, EXIT.REFUSED);
  assert.equal((await knime(k, "node", "rm", "--prefix", "m")).code, EXIT.REFUSED);
  assert.equal(k.nodes.size, 3);
  const dry = await knime(k, "node", "rm", "--prefix", "my:", "--dry-run", "--json");
  assert.equal(dry.json.data.wouldDelete.length, 2);
  assert.equal(k.nodes.size, 3);
  assert.equal((await knime(k, "node", "rm", "--prefix", "my:")).code, 0);
  assert.deepEqual([...k.nodes.keys()], ["root:3"]);
  assert.equal((await knime(k, "node", "rm", "root:3", "--force")).code, 0);
});

test("node add resolves aliases, labels and wires the node", async () => {
  const k = workflow();
  const r = await knime(k, "node", "add", "partition", "--label", "my:p2", "--from", "my:part:2", "--json");
  assert.equal(r.code, 0);
  assert.equal(k.nodes.get(r.json.data.id)!.label, "my:p2");
  assert.ok(k.connections.some((c) => c.sourceNode === "root:2" && c.sourcePort === 2 && c.destNode === r.json.data.id));
  assert.equal((await knime(k, "node", "add", "parttion")).code, EXIT.NOT_FOUND);
});

test("node connect parses node:port with labels that contain colons", async () => {
  const k = workflow();
  const r = await knime(k, "node", "connect", "my:reader:1", "root:3", "--json");
  assert.deepEqual(r.json.data, { from: "root:1:1", to: "root:3:1" });
  const bad = await knime(k, "node", "connect", "my:reader:5", "root:3", "--json");
  assert.equal(bad.json.error.code, "CONNECTION_FAILED");
  assert.match(bad.json.error.cause, /port 0 is the flow-variable port/);
  assert.match(bad.json.error.message, /root:1 has no output port 5\. root:1 outputs: 0 \(Flow Variable\), 1 \(Table\); root:3 inputs: /);
});

test("run exits 8 listing nodes that stayed IDLE although the server said done", async () => {
  const k = workflow();
  k.nodes.get("root:2")!.staysIdle = true;
  const r = await knime(k, "run", "my:part", "--json");
  assert.equal(r.code, EXIT.INCOMPLETE);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.data.code, "NOT_EXECUTED");
  assert.deepEqual(r.json.data.notExecuted.map((n: { id: string }) => n.id), ["root:2"]);
  assert.match(r.json.data.notExecuted[0].hint, /IDLE/);
});

test("run succeeds when everything in scope executed", async () => {
  const r = await knime(workflow(), "run", "my:part");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /2 executed, 0 not executed/);
});

test("WRITE commands warn when they leave unsaved changes; READ commands don't check", async () => {
  const k = workflow();
  const read = await knime(k, "node", "settings", "my:reader", "--json");
  assert.equal(read.json.dirty, undefined);
  const r = await knime(k, "node", "label", "root:3", "my:third", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.json.dirty, true);
  assert.ok(r.json.warnings.some((w: string) => /project "Test" has unsaved changes; `knime save` saves them/.test(w)), r.json.warnings);
  const human = await knime(k, "node", "label", "root:3", "my:3rd");
  assert.match(human.stderr, /warning: project "Test" has unsaved changes/);
});

test("a failed WRITE command still reports unsaved changes", async () => {
  const k = workflow();
  k.dirty = true;
  const r = await knime(k, "node", "set", "my:reader", "bogus=1", "--json");
  assert.equal(r.code, EXIT.REJECTED);
  assert.equal(r.json.dirty, true);
  assert.ok(r.json.warnings.some((w: string) => /unsaved changes/.test(w)));
});

test("node set warns first when the project was already dirty, and only when it resets", async () => {
  const k = workflow();
  const clean = await knime(k, "node", "set", "my:reader", "seed=5", "--json");
  assert.ok(!clean.json.warnings.some((w: string) => /already had unsaved changes/.test(w)));
  const again = await knime(k, "node", "set", "my:reader", "seed=6", "--json");
  assert.ok(again.json.warnings.some((w: string) => /already had unsaved changes .* `knime save`/.test(w)), again.json.warnings);
  const same = await knime(k, "node", "set", "my:reader", "seed=6", "--json");
  assert.ok(!same.json.warnings.some((w: string) => /already had/.test(w)), "a no-op patch resets nothing");
});

test("save saves a dirty project in place, and then nothing is unsaved", async () => {
  const k = workflow();
  k.dirty = true;
  const r = await knime(k, "save", "--json");
  assert.equal(r.code, 0);
  assert.equal(r.json.data.saved, true);
  assert.equal(r.json.data.path, "/ws/Test");
  assert.equal(r.json.dirty, false);
  assert.ok(!r.json.warnings.some((w: string) => /unsaved/.test(w)));
  assert.equal(k.saves, 1);
  const again = await knime(k, "save", "--json");
  assert.equal(again.json.data.saved, false, "a clean project isn't saved again");
  assert.equal(k.saves, 1);
});

test("save explains a project that can't be saved in place (exit 7)", async () => {
  const k = workflow();
  k.dirty = true;
  k.saveBlocked = "it is a temporary copy of a Hub workflow";
  const r = await knime(k, "save", "--json");
  assert.equal(r.code, EXIT.REJECTED);
  assert.equal(r.json.error.code, "SAVE_BLOCKED");
  assert.match(r.json.error.message, /temporary copy of a Hub workflow/);
  assert.match(r.json.error.cause, /component project/);
});

test("workflow show and status report unsaved changes and whether the project can be saved", async () => {
  const k = workflow();
  k.dirty = true;
  const w = await knime(k, "workflow", "show", "--json");
  assert.equal(w.json.data.project.dirty, true);
  assert.equal(w.json.data.project.canSave, true);
  assert.equal(w.json.data.project.path, "/ws/Test");
  assert.match((await knime(k, "workflow", "show")).stdout, /project Test: unsaved changes \(`knime save`\)/);
  const st = await knime(k, "status", "--json");
  assert.equal(st.json.data.project.dirty, true);
});

test("node ports lists ports with columns, and why a spec is missing", async () => {
  const k = workflow();
  k.nodes.get("root:1")!.columns = [{ name: "city", type: "String", domain: { values: ["Perth", "Hobart"] } }, { name: "sales", type: "Number (Integer)", domain: { lower: 4, upper: 13 } }];
  const before = await knime(k, "node", "ports", "my:part", "--json");
  assert.equal(before.code, 0);
  assert.equal(before.json.data.inputs[1].spec, null);
  assert.match(before.json.data.inputs[1].reason, /until the node executes/);
  await knime(k, "run", "my:reader");
  const r = await knime(k, "node", "ports", "my:part");
  assert.match(r.stdout, /^ {2}1 \(Table\) ← root:1 \[my:reader\]:1: 2 column\(s\)$/m);
  assert.match(r.stdout, /^ {6}city: String \{Perth, Hobart\}$/m);
  assert.match(r.stdout, /^ {6}sales: Number \(Integer\) \[4, 13\]$/m);
  const show = await knime(k, "workflow", "show", "--ports", "--json");
  assert.deepEqual(show.json.data.nodes[1].inPorts[1].spec.columns.map((c: { name: string }) => c.name), ["city", "sales"]);
  assert.match((await knime(k, "workflow", "show", "--ports")).stdout, /in: {2}0 \(Flow Variable\): flow variables \| 1 \(Table\): 2 column\(s\)/);
});

test("guide and nodes need no KNIME", async () => {
  const io: Io = { stdout: () => {}, stderr: () => {}, connect: async () => { throw new Error("should not connect"); } };
  assert.equal(await main(COMMANDS, ["guide", "settings"], io), 0);
  assert.equal(await main(COMMANDS, ["nodes", "info", "rf-learn"], io), 0);
  assert.equal(await main(COMMANDS, ["nodes", "search", "tree"], io), 0);
});
