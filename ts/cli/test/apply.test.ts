import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { apply, expandEnv, parseEndpoint, planApply, resolveSpec, type PipelineSpec } from "../apply.ts";
import { byAlias } from "../catalogue.ts";
import { CliError } from "../errors.ts";
import { FakeKnime } from "./fake.ts";

const F = (alias: string) => byAlias(alias)!.factory;

const SPEC: PipelineSpec = {
  prefix: "t:",
  nodes: [
    { key: "reader", alias: "csv-reader", settings: { "source.path.path": "/x.csv" } },
    { key: "part", alias: "partition", settings: { percentage: 80, seed: 42 } },
    { key: "learn", alias: "linreg-learn", settings: { target: "y" } },
    { key: "pred", alias: "reg-predict" },
  ],
  connections: [
    { from: "reader", to: "part" },
    { from: "part:1", to: "learn:1" },
    { from: "learn:1", to: "pred:1" },
    { from: "part:2", to: "pred:2" },
  ],
};

/** A fake whose nodes have the settings the spec patches; the learner's only appear once its input ran. */
function fake(): FakeKnime {
  const k = new FakeKnime();
  k.defaults[F("csv-reader")] = { inPorts: 1, outPorts: 2, model: { csv: { source: { path: { path: "" } } } } };
  k.defaults[F("partition")] = { inPorts: 2, outPorts: 3, model: { percentage: 70, seed: 1 } };
  k.defaults[F("linreg-learn")] = { inPorts: 2, outPorts: 3, model: {}, modelWhenFed: { target: "guess" } };
  k.defaults[F("reg-predict")] = { inPorts: 3, outPorts: 2 };
  return k;
}

test("parseEndpoint defaults to port 1", () => {
  assert.deepEqual(parseEndpoint("a"), { key: "a", port: 1 });
  assert.deepEqual(parseEndpoint("a:0"), { key: "a", port: 0 });
  assert.throws(() => parseEndpoint("a:b:c"), /Bad endpoint/);
});

test("expandEnv fills variables and defaults, and fails on unset ones", () => {
  assert.deepEqual(expandEnv({ p: "${D}/x", q: ["${N:-none}"] }, { D: "/data" }), { p: "/data/x", q: ["none"] });
  assert.throws(() => expandEnv("${NOPE}", {}), /NOPE is not set/);
});

test("resolveSpec orders upstream first and defaults run to the sinks", () => {
  const s = resolveSpec({ ...SPEC, nodes: [...SPEC.nodes].reverse() });
  assert.deepEqual(s.nodes.map((n) => n.key), ["reader", "part", "learn", "pred"]);
  assert.deepEqual(s.nodes.map((n) => n.depth), [0, 1, 2, 3]);
  assert.deepEqual(s.run, ["pred"]);
  assert.equal(s.nodes[0]!.label, "t:reader");
});

test("resolveSpec reports every problem at once", () => {
  const err = (() => {
    try {
      resolveSpec({
        prefix: "x",
        nodes: [{ key: "a", alias: "nope" }, { key: "a:b", alias: "csv-reader" }, { key: "b", alias: "partition" }, { key: "c", alias: "partition" }],
        connections: [{ from: "b:9", to: "c" }, { from: "c", to: "b" }, { from: "z", to: "b" }, { from: "c:2", to: "c" }],
      });
    } catch (e) {
      return e as CliError;
    }
  })();
  assert.ok(err instanceof CliError);
  const problems = err.details as string[];
  for (const re of [/prefix/, /unknown alias "nope"/, /no colons/, /no output port 9/, /unknown node "z"/, /c:1 already has an input/, /cycle/]) {
    assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}: ${problems.join(" | ")}`);
  }
});

test("the example spec resolves", () => {
  const raw = JSON.parse(readFileSync(new URL("../examples/housing-small.json", import.meta.url), "utf8"));
  const s = resolveSpec(raw, { HOUSING_CSV: "/data/housing.csv" });
  assert.deepEqual(s.nodes.map((n) => n.key), ["reader", "missing", "partition", "learn", "predict", "score"]);
  assert.equal(s.nodes[0]!.settings!["source.path.path"], "/data/housing.csv");
  assert.deepEqual(s.run, ["score"]);
});

test("planner adds everything into an empty workflow, right of existing nodes", async () => {
  const k = fake();
  k.add({ factory: "other.Factory", label: "mine", x: 1000 });
  const plan = planApply(resolveSpec(SPEC), await k.session().snapshot());
  assert.deepEqual(plan.nodes.map((n) => n.action), ["add", "add", "add", "add"]);
  assert.ok(plan.nodes.every((n) => n.position!.x > 1000));
  assert.deepEqual(plan.remove, []);
  assert.ok(plan.connections.every((c) => c.action === "connect"));
});

test("planner reuses matching nodes and removes only prefixed strays", async () => {
  const k = fake();
  const reader = k.add({ factory: F("csv-reader"), label: "t:reader" });
  const part = k.add({ factory: F("column-filter"), label: "t:part" }); // wrong factory
  const stray = k.add({ factory: F("partition"), label: "t:old" });
  const dupe = k.add({ factory: F("csv-reader"), label: "t:reader" });
  const theirs = k.add({ factory: F("partition"), label: "u:part" });
  const unlabelled = k.add({ factory: F("partition") });
  const other = k.add({ factory: F("partition"), label: "t:pred-in" });
  k.connect(other.id, 1, reader.id, 1); // into a reused node, on a port the spec doesn't feed
  const plan = planApply(resolveSpec(SPEC), await k.session().snapshot());
  assert.deepEqual(plan.remove.map((r) => r.id).sort(), [part.id, stray.id, dupe.id, other.id].sort());
  assert.ok(!plan.remove.some((r) => r.id === theirs.id || r.id === unlabelled.id), "never touches unprefixed nodes");
  assert.equal(plan.nodes.find((n) => n.key === "reader")!.action, "reuse");
  assert.equal(plan.nodes.find((n) => n.key === "part")!.action, "add");
  assert.deepEqual(plan.disconnect, [], "inputs from removed nodes go with them");
});

test("planner disconnects inputs of reused nodes that the spec doesn't feed", async () => {
  const k = fake();
  const reader = k.add({ factory: F("csv-reader"), label: "t:reader" });
  const part = k.add({ factory: F("partition"), label: "t:part" });
  const foreign = k.add({ factory: F("partition") });
  k.connect(reader.id, 1, part.id, 1);
  k.connect(foreign.id, 1, reader.id, 1);
  const plan = planApply(resolveSpec(SPEC), await k.session().snapshot());
  assert.equal(plan.connections.find((c) => c.to.key === "part")!.action, "keep");
  assert.deepEqual(plan.disconnect.map((d) => d.to), ["reader:1"]);
});

test("--rebuild removes every prefixed node", async () => {
  const k = fake();
  k.add({ factory: F("csv-reader"), label: "t:reader" });
  const plan = planApply(resolveSpec(SPEC), await k.session().snapshot(), { rebuild: true });
  assert.equal(plan.remove.length, 1);
  assert.equal(plan.nodes[0]!.action, "add");
});

test("apply builds progressively: inputs run before a node's settings are read", async () => {
  const k = fake();
  const r = await apply(k.session(), resolveSpec(SPEC));
  assert.ok(r.run?.ok, JSON.stringify(r.run));
  const labels = [...k.nodes.values()].map((n) => n.label).sort();
  assert.deepEqual(labels, ["t:learn", "t:part", "t:pred", "t:reader"]);
  // The learner's target only exists once partition ran; apply must have executed it first.
  const learner = [...k.nodes.values()].find((n) => n.label === "t:learn")!;
  assert.equal(learner.model.target, "y");
  const order = k.calls.map((c) => c.method === "/api/node/settings/set" ? `set:${c.body.nodeId}` : c.method);
  const setLearner = order.indexOf(`set:${learner.id}`);
  assert.ok(order.slice(0, setLearner).includes("/api/execute"), "executed upstream before patching the learner");
  assert.equal(r.patched.find((p) => p.key === "part")!.changed, true);
});

test("apply is idempotent: a second run reuses everything and changes nothing", async () => {
  const k = fake();
  await apply(k.session(), resolveSpec(SPEC));
  const before = k.commands().length;
  const r = await apply(k.session(), resolveSpec(SPEC));
  assert.deepEqual(r.plan.nodes.map((n) => n.action), ["reuse", "reuse", "reuse", "reuse"]);
  assert.ok(r.plan.connections.every((c) => c.action === "keep"));
  assert.equal(k.commands().length, before, "no workflow commands on a no-op re-run");
  assert.ok(r.patched.every((p) => !p.changed));
});

test("apply fails honestly when nodes stay IDLE although execute reports done", async () => {
  const k = fake();
  k.defaults[F("reg-predict")] = { inPorts: 3, outPorts: 2, staysIdle: true };
  const r = await apply(k.session(), resolveSpec(SPEC));
  assert.equal(r.run!.ok, false);
  assert.deepEqual(r.run!.notExecuted.map((n) => n.label), ["t:pred"]);
  assert.equal(r.run!.failed.length, 0, "the server said nothing failed");
});

test("apply refuses to patch a node whose settings never appear", async () => {
  const k = fake();
  k.defaults[F("linreg-learn")] = { inPorts: 2, outPorts: 3, model: {} };
  await assert.rejects(apply(k.session(), resolveSpec(SPEC)), (e: CliError) => e.code === "EMPTY_MODEL");
});

test("a 504 on add_node is recovered by finding and labelling the new node", async () => {
  const k = fake();
  k.timeoutNext = "add_node";
  const r = await apply(k.session(), resolveSpec(SPEC));
  assert.match(r.warnings.join("\n"), /timed out but the node appeared/);
  assert.equal([...k.nodes.values()].filter((n) => n.label === "t:reader").length, 1);
  assert.equal(k.nodes.size, 4);
});

test("a 504 on another command stops with GATEWAY_TIMEOUT", async () => {
  const k = fake();
  k.timeoutNext = "connect";
  await assert.rejects(apply(k.session(), resolveSpec(SPEC)), (e: CliError) => e.code === "GATEWAY_TIMEOUT" && /connect/.test(e.message));
});

test("a fresh tree learner's incomplete read is completed by its preset, quietly, and re-applying is a no-op", async () => {
  const k = fake();
  const fresh = { targetColumn: null, seed: "1", maxLevels: -1, minNodeSize: -1, minChildSize: -1, dataFraction: 1,
    isDataSelectionWithReplacement: false, hardCodedRootColumn: null, columnSamplingMode: "SquareRoot",
    columnFractionPerTree: 1, columnAbsolutePerTree: 10, isUseDifferentAttributesAtEachNode: false, nrModels: 100 };
  k.defaults[F("rf-learn")] = { inPorts: 2, outPorts: 4, model: fresh, completesWith: "splitCriterion" };
  k.defaults[F("rf-predict")] = { inPorts: 3, outPorts: 2 };
  const spec = resolveSpec({
    prefix: "t:",
    nodes: [
      { key: "reader", alias: "csv-reader" },
      { key: "rf", alias: "rf-learn", preset: { name: "regression", target: "y" }, settings: { nrModels: 50 } },
      { key: "pred", alias: "rf-predict" },
    ],
    connections: [{ from: "reader", to: "rf" }, { from: "rf:3", to: "pred:1" }, { from: "reader", to: "pred:2" }],
  });
  const r = await apply(k.session(), spec);
  assert.deepEqual(r.warnings, []);
  const rf = [...k.nodes.values()].find((n) => n.label === "t:rf")!;
  assert.equal(rf.model.splitCriterion, "InformationGainRatio");
  assert.equal(rf.model.nrModels, 50);
  assert.ok(r.run!.ok);
  const again = await apply(k.session(), spec);
  assert.ok(again.patched.every((p) => !p.changed), JSON.stringify(again.patched.filter((p) => p.changed)));
});

test("a learner left incomplete after the set is reported", async () => {
  const k = fake();
  k.defaults[F("rf-learn")] = { inPorts: 2, outPorts: 4, model: { nrModels: 100, targetColumn: null }, completesWith: "splitCriterion" };
  const spec = resolveSpec({ prefix: "t:", nodes: [{ key: "rf", alias: "rf-learn", settings: { nrModels: 10 } }] });
  const r = await apply(k.session(), spec, { noRun: true });
  assert.match(r.warnings.join("\n"), /t:rf: settings are still incomplete \(save failed after nrModels; splitCriterion is missing\)/);
});
