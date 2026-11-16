import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveSpec } from "../apply.ts";
import { CATALOGUE } from "../catalogue.ts";
import { CliError } from "../errors.ts";
import { planObject } from "../patch.ts";
import { isObject } from "../paths.ts";
import { buildPreset, overlay, PRESETS } from "../presets.ts";
import type { Json, JsonObject } from "../types.ts";

/** What the server holds after a typed set: the same settings, without the $type wrappers. */
function unwrap(v: Json): Json {
  if (isObject(v) && "$type" in v) return unwrap(v.value ?? null);
  if (Array.isArray(v)) return v.map(unwrap);
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
  return v;
}

/** A fresh tree learner's read: cut short after nrModels, with nulls shown. */
const FRESH_TREE: JsonObject = {
  targetColumn: null, seed: "1794864537642", maxLevels: -1, minNodeSize: -1, minChildSize: -1, dataFraction: 1,
  isDataSelectionWithReplacement: false, hardCodedRootColumn: null, columnSamplingMode: "SquareRoot",
  columnFractionPerTree: 1, columnAbsolutePerTree: 10, isUseDifferentAttributesAtEachNode: false, nrModels: 100,
};

test("every preset belongs to a catalogue alias and builds its example", () => {
  for (const [alias, presets] of Object.entries(PRESETS)) {
    assert.ok(CATALOGUE.some((e) => e.alias === alias), alias);
    for (const p of presets) assert.ok(Object.keys(p.build(p.example)).length, `${alias}:${p.name}`);
  }
});

test("the rf preset completes a fresh learner with typed keys, and is a no-op once applied", () => {
  const { settings } = buildPreset("rf-learn", { name: "regression", target: "y", exclude: ["id"] });
  const first = planObject(FRESH_TREE, settings);
  assert.deepEqual(first.warnings, [], "typed keys are created without warnings or suffix guesses");
  const created = first.changes.filter((c) => c.kind === "new").map((c) => c.path);
  for (const k of ["splitCriterion", "missingValueHandling", "columnFilterConfig", "rowSamplingMode"]) assert.ok(created.includes(k), k);
  assert.deepEqual(unwrap(settings.columnFilterConfig!), {
    "filter-type": "STANDARD", included_names: [], excluded_names: ["y", "id"], enforce_option: "EnforceExclusion",
  });
  const after = { ...FRESH_TREE, ...(unwrap(first.patch) as JsonObject) };
  const again = planObject(after, settings);
  assert.deepEqual(again.patch, {}, JSON.stringify(again.changes.filter((c) => c.kind !== "same")));
});

test("features switch the filter to EnforceInclusion", () => {
  const { settings } = buildPreset("gbt-learn", { name: "regression", target: "y", features: ["a", "b"] });
  assert.equal((unwrap(settings.columnFilterConfig!) as JsonObject).enforce_option, "EnforceInclusion");
  assert.deepEqual(settings.alphaFraction, { $type: "double", value: 0.95 });
});

test("preset parameters are checked", () => {
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as CliError).code + ": " + (e as Error).message; } };
  assert.match(code(() => buildPreset("rf-learn", "regression"))!, /needs "target"/);
  assert.match(code(() => buildPreset("rf-learn", { name: "regression", target: "y", trees: 5 }))!, /no parameter "trees"/);
  assert.match(code(() => buildPreset("rf-learn", { name: "regression", target: "y", exclude: "id" }))!, /must be string\[\]/);
  assert.match(code(() => buildPreset("rf-learn", { name: "fast", target: "y" }))!, /no preset "fast"; it has: regression/);
  assert.match(code(() => buildPreset("csv-reader", "x"))!, /BAD_PRESET/);
});

test("overrides keep the preset's type and reach into typed configs", () => {
  const { settings } = buildPreset("gbt-learn", { name: "regression", target: "y" });
  const o = overlay(settings, { learningRate: 0.05, nrModels: 1000, "columnFilterConfig.enforce_option": "EnforceInclusion" });
  assert.deepEqual(o.learningRate, { $type: "double", value: 0.05 });
  assert.equal(o.nrModels, 1000);
  assert.equal(((o.columnFilterConfig as JsonObject).value as JsonObject).enforce_option, "EnforceInclusion");
  assert.deepEqual(settings.learningRate, { $type: "double", value: 0.1 }, "the preset itself is untouched");
});

test("GroupBy and Column Renamer presets build the typed shapes the server needs", () => {
  const g = buildPreset("groupby", { name: "aggregate", groupBy: ["k"], aggregations: [{ column: "v", method: "Count" }, { column: "v", method: "Mean_V4.6" }] }).settings;
  assert.deepEqual(g, {
    grouByColumns: { InclList: ["k"] },
    aggregationColumn: {
      columnNames: ["v", "v"],
      columnTypes: { $type: "config[]", value: [{ cell_class: "org.knime.core.data.def.DoubleCell", is_null: false }, { cell_class: "org.knime.core.data.def.DoubleCell", is_null: false }] },
      aggregationMethod: ["Count", "Mean_V4.6"],
      inclMissingVals: { $type: "boolean[]", value: [false, false] },
    },
  });
  const r = buildPreset("column-renamer", { name: "rename", renames: { "Count*(v)": "n" } }).settings;
  assert.deepEqual(r, { renamings: { "0": { $type: "config", value: { oldName: "Count*(v)", newName: "n" } } } });
});

test("an apply spec can use a preset with overrides and environment variables", () => {
  const s = resolveSpec({
    prefix: "t:",
    nodes: [{ key: "rf", alias: "rf-learn", preset: { name: "regression", target: "${TARGET}" }, settings: { nrModels: 50 } }],
  }, { TARGET: "price" });
  assert.equal(s.nodes[0]!.settings!.targetColumn, "price");
  assert.equal(s.nodes[0]!.settings!.nrModels, 50);
  assert.throws(() => resolveSpec({ prefix: "t:", nodes: [{ key: "rf", alias: "rf-learn", preset: "regression" }] }), /needs "target"/);
});
