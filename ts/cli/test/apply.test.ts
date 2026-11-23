import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

test("expandEnv nests defaults, and HOME falls back to the OS home folder", () => {
  assert.equal(expandEnv("${D:-${HOME}/x.csv}", { HOME: "/home/u" }), "/home/u/x.csv");
  assert.equal(expandEnv("${D:-${HOME}/x.csv}", { D: "/data/y.csv", HOME: "/home/u" }), "/data/y.csv");
  assert.equal(expandEnv("${HOME}", {}), homedir());
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
  for (const re of [/prefix/, /unknown alias "nope"/, /no colons/, /unknown node "z"/, /c:1 already has an input/, /cycle/]) {
    assert.ok(problems.some((p) => re.test(p)), `expected a problem matching ${re}: ${problems.join(" | ")}`);
  }
});

test("the example spec resolves", () => {
  const raw = JSON.parse(readFileSync(new URL("../examples/housing-small.json", import.meta.url), "utf8"));
  const s = resolveSpec(raw, { HOUSING_CSV: "/data/housing.csv" });
  assert.deepEqual(s.nodes.map((n) => n.key), ["reader", "missing", "partition", "learn", "predict", "score", "rf-learn", "rf-predict", "rf-score"]);
  assert.equal(s.nodes[0]!.settings!["source.path.path"], "/data/housing.csv");
  assert.deepEqual(s.run, ["score", "rf-score"]);
  const byDefault = resolveSpec(raw, { HOME: "/home/u" });
  assert.equal(byDefault.nodes[0]!.settings!["source.path.path"], "/home/u/knime-workspace/knime-cli-demo/california-housing/housing.csv");
  assert.equal(s.nodes.find((n) => n.key === "rf-learn")!.settings!.nrModels, 100);
});

test("apply reports whether the project was dirty before it changed anything", async () => {
  const seen: (boolean | undefined)[] = [];
  const k = fake();
  await apply(k.session(), resolveSpec(SPEC), { noRun: true, onStart: (snap) => seen.push(snap.dirty) });
  await apply(k.session(), resolveSpec(SPEC), { noRun: true, onStart: (snap) => seen.push(snap.dirty) });
  assert.deepEqual(seen, [false, true]);
});

test("a wrong port fails at connect time, naming the ports KNIME really has", async () => {
  const k = fake();
  const spec = structuredClone(SPEC);
  spec.connections![1] = { from: "part:9", to: "learn:1" };
  await assert.rejects(apply(k.session(), resolveSpec(spec), { noRun: true }),
    (e: CliError) => e.code === "CONNECTION_FAILED" && /has no output port 9\. root:2 outputs: 0 \(Flow Variable\), 1 \(Table\), 2 \(Table\)/.test(e.message));
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

test("apply creates typed settings on a node that shows none, as Math Formula does before its dialog has saved", async () => {
  const k = fake();
  k.defaults[F("linreg-learn")] = { inPorts: 2, outPorts: 3, model: {} };
  const spec = structuredClone(SPEC);
  spec.nodes[2]!.settings = { target: { $type: "string", value: "y" }, append: { $type: "boolean", value: true } };
  const r = await apply(k.session(), resolveSpec(spec));
  assert.ok(r.patched.find((p) => p.key === "learn")?.changed);
  const learner = [...k.nodes.values()].find((n) => n.factory === F("linreg-learn"))!;
  assert.deepEqual(learner.model, { target: "y", append: true });
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

const ANNOTATED: PipelineSpec = {
  ...SPEC,
  nodes: SPEC.nodes.map((n) => (n.key === "reader" ? { ...n, note: "Reads the extract" } : n)),
  annotations: [
    { key: "prep", text: "Data prep", colour: "meadow", around: ["reader", "part"] },
    { key: "model", text: "Model", colour: "Carrot", around: ["learn", "pred"] },
  ],
};

test("resolveSpec checks annotations: keys, nodes, placement and colour", () => {
  const s = resolveSpec(ANNOTATED);
  assert.deepEqual(s.annotations.map((a) => [a.tag, a.colour, a.html]), [
    ["t:prep", "#3CB44B", "<p>Data prep</p><p>[[t:prep]]</p>"],
    ["t:model", "#FF9632", "<p>Model</p><p>[[t:model]]</p>"],
  ]);
  try {
    resolveSpec({
      ...SPEC,
      annotations: [
        { key: "a", around: ["nope"] },
        { key: "a", bounds: [0, 0, 10, 10], around: ["reader"] },
        { key: "c", colour: "chartreuse", bounds: [0, 0, 10, 10] },
        { key: "d" },
        { key: "e", bounds: [0, 0, 0, 10] },
      ],
    });
    assert.fail("should throw");
  } catch (e) {
    const p = (e as CliError).details as string[];
    assert.ok(p.some((x) => /unknown node "nope"/.test(x)));
    assert.ok(p.some((x) => /duplicate key "a"/.test(x)));
    assert.ok(p.some((x) => /\(a\): give around .* or bounds, exactly one/.test(x)));
    assert.ok(p.some((x) => /\(c\).*chartreuse/.test(x)));
    assert.ok(p.some((x) => /\(d\): give around/.test(x)));
    assert.ok(p.some((x) => /\(e\): bounds must be/.test(x)));
  }
});

test("apply annotates stages round their nodes and notes nodes, then re-runs as a no-op", async () => {
  const k = fake();
  k.annotate({ text: "<p>not ours</p>" });
  const spec = resolveSpec(ANNOTATED);
  const r = await apply(k.session(), spec, { noRun: true });
  assert.deepEqual(r.annotations.map((a) => [a.tag, a.action]), [["t:prep", "added"], ["t:model", "added"]]);
  const reader = [...k.nodes.values()].find((n) => n.label?.startsWith("t:reader"))!;
  assert.equal(reader.label, "t:reader\nReads the extract");
  const prep = k.annotations.find((a) => a.text?.value?.includes("[[t:prep]]"))!;
  const part = [...k.nodes.values()].find((n) => n.label === "t:part")!;
  for (const n of [reader, part]) assert.ok(n.x > prep.bounds.x && n.x + 32 < prep.bounds.x + prep.bounds.width);
  assert.equal(prep.borderColor, "#3CB44B");

  const before = k.commands().length;
  const again = await apply(k.session(), spec, { noRun: true });
  assert.deepEqual(again.annotations.map((a) => a.action), ["kept", "kept"]);
  assert.deepEqual(k.commands().slice(before).map((c) => c.kind), [], "nothing to send on a re-run");
  assert.equal(k.annotations.length, 3);
});

test("apply refreshes changed annotations, removes dropped ones, and leaves untagged ones alone", async () => {
  const k = fake();
  const theirs = k.annotate({ text: "<p>not ours</p>" });
  await apply(k.session(), resolveSpec(ANNOTATED), { noRun: true });
  const prepId = k.annotations.find((a) => a.text?.value?.includes("[[t:prep]]"))!.id;
  k.annotations.find((a) => a.id === prepId)!.bounds.x -= 500; // someone dragged it
  const changed = resolveSpec({
    ...ANNOTATED,
    nodes: SPEC.nodes.map((n) => (n.key === "reader" ? { ...n, note: "" } : n)),
    annotations: [{ key: "prep", text: "Prep", colour: "coral", around: ["reader", "part"] }],
  });
  const plan = planApply(changed, await k.session().snapshot());
  assert.deepEqual(plan.removeAnnotations.map((a) => a.tag), ["t:model"]);
  assert.deepEqual(plan.nodes.find((n) => n.key === "reader")!.note, "clear");
  const r = await apply(k.session(), changed, { noRun: true });
  assert.deepEqual(r.annotations, [{ key: "prep", tag: "t:prep", id: prepId, action: "updated", changed: ["text", "colour", "bounds"] }]);
  assert.deepEqual(k.annotations.map((a) => a.id).sort(), [theirs.id, prepId].sort());
  assert.equal([...k.nodes.values()].find((n) => n.label?.startsWith("t:reader"))!.label, "t:reader");
});

test("a spec without note leaves a node's note alone", async () => {
  const k = fake();
  await apply(k.session(), resolveSpec(ANNOTATED), { noRun: true });
  const r = await apply(k.session(), resolveSpec(SPEC), { noRun: true });
  assert.equal(r.plan.nodes.find((n) => n.key === "reader")!.note, undefined);
  assert.equal([...k.nodes.values()].find((n) => n.label?.startsWith("t:reader"))!.label, "t:reader\nReads the extract");
  assert.deepEqual(r.plan.removeAnnotations.map((a) => a.tag).sort(), ["t:model", "t:prep"], "annotations dropped from the spec go");
});
