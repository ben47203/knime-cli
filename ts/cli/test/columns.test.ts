import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, resolveSpec, type PipelineSpec } from "../apply.ts";
import { byAlias } from "../catalogue.ts";
import { findSelectors, selectColumns, selectorProblems, substitute } from "../columns.ts";
import { CliError } from "../errors.ts";
import type { ColumnSpec } from "../types.ts";
import { FakeKnime } from "./fake.ts";

const COLUMNS: ColumnSpec[] = [
  { name: "longitude", type: "Number (Float)" },
  { name: "rooms", type: "Number (Integer)" },
  { name: "ocean_proximity", type: "String" },
  { name: "median_house_value", type: "Number (Float)" },
  { name: "sold", type: "Local Date" },
];

test("selectColumns filters by type group, pattern, include and exclude", () => {
  assert.deepEqual(selectColumns({ type: "number", exclude: ["median_house_value"] }, COLUMNS).names, ["longitude", "rooms"]);
  assert.deepEqual(selectColumns({ type: "integer" }, COLUMNS).names, ["rooms"]);
  assert.deepEqual(selectColumns({ type: ["string", "datetime"] }, COLUMNS).names, ["ocean_proximity", "sold"]);
  assert.deepEqual(selectColumns({ pattern: "^(long|med)" }, COLUMNS).names, ["longitude", "median_house_value"]);
  assert.deepEqual(selectColumns({ include: ["rooms", "longitude"] }, COLUMNS).names, ["rooms", "longitude"], "include keeps its order");
  assert.deepEqual(selectColumns({}, COLUMNS).names.length, 5);
});

test("selectColumns warns about names that aren't there and about picking nothing", () => {
  const r = selectColumns({ type: "number", exclude: ["median_house_valeu"] }, COLUMNS);
  assert.match(r.warnings.join("\n"), /exclude names "median_house_valeu", not in the input/);
  assert.match(selectColumns({ type: "boolean" }, COLUMNS).warnings.join("\n"), /picks no columns/);
});

test("selectors are found and substituted anywhere, including inside typed values", () => {
  const settings = { a: { $columns: { type: "number" } }, b: { $type: "string[]", value: { $columns: { include: ["x"] } } }, c: [1] };
  assert.equal(findSelectors(settings).length, 2);
  assert.deepEqual(substitute(settings, () => ["n"]), { a: ["n"], b: { $type: "string[]", value: ["n"] }, c: [1] });
});

test("selectorProblems rejects unknown fields, bad types and bad patterns", () => {
  assert.deepEqual(selectorProblems({ from: "r:1", type: "number" }), []);
  assert.match(selectorProblems({ form: "r" }).join(), /unknown "\$columns" field\(s\) form/);
  assert.match(selectorProblems({ exclude: "y" }).join(), /exclude must be an array/);
  assert.match(selectorProblems({ pattern: "(" }).join(), /pattern/);
  assert.match(selectorProblems("number").join(), /must be an object/);
});

const F = (alias: string) => byAlias(alias)!.factory;

const SPEC: PipelineSpec = {
  prefix: "c:",
  nodes: [
    { key: "reader", alias: "csv-reader" },
    { key: "missing", alias: "missing-value" },
    {
      key: "learn", alias: "linreg-learn",
      settings: { target: "median_house_value", column_filter: { included_names: { $columns: { from: "missing:1", type: "number", exclude: ["median_house_value"] } } } },
    },
  ],
  connections: [{ from: "reader", to: "missing" }, { from: "missing", to: "learn" }],
};

function fake(): FakeKnime {
  const k = new FakeKnime();
  k.defaults[F("csv-reader")] = { inPorts: 1, outPorts: 2, columns: COLUMNS };
  k.defaults[F("missing-value")] = { inPorts: 2, outPorts: 3, columns: COLUMNS };
  k.defaults[F("linreg-learn")] = { inPorts: 2, outPorts: 3, model: {}, modelWhenFed: { target: "guess", column_filter: { included_names: [] } } };
  return k;
}

test("apply resolves $columns from the upstream output spec at that step", async () => {
  const k = fake();
  const r = await apply(k.session(), resolveSpec(SPEC), { noRun: true });
  const learner = [...k.nodes.values()].find((n) => n.label === "c:learn")!;
  assert.deepEqual((learner.model.column_filter as { included_names: string[] }).included_names, ["longitude", "rooms"]);
  assert.deepEqual(r.warnings, []);
});

test("without from, $columns reads what feeds input 1; resolveSpec checks the selector", () => {
  const spec = structuredClone(SPEC);
  spec.nodes[2]!.settings = { features: { $columns: { type: "number" } } };
  assert.deepEqual(resolveSpec(spec).nodes.find((n) => n.key === "learn")!.columnSources, [{ key: "missing", port: 1 }]);
  spec.nodes[2]!.settings = { features: { $columns: { from: "nope:1" } } };
  assert.throws(() => resolveSpec(spec), (e: CliError) => /unknown node "nope"/.test(e.message));
  spec.nodes[0]!.settings = { x: { $columns: {} } };
  assert.throws(() => resolveSpec(spec), (e: CliError) => /needs a connection into reader:1/.test(e.message));
});

test("apply fails clearly when the source port has no table spec", async () => {
  const k = fake();
  k.defaults[F("missing-value")] = { inPorts: 2, outPorts: 3 }; // no columns known
  await assert.rejects(apply(k.session(), resolveSpec(SPEC), { noRun: true }), (e: CliError) => e.code === "NO_COLUMNS" && /missing:1/.test(e.message));
});
