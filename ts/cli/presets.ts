/**
 * Presets: complete, known-good settings for nodes whose settings are too intricate to write by hand (the tree
 * learners' typed completion, GroupBy's parallel arrays, Column Renamer's typed entries). A preset is built from a
 * few parameters; `apply` and `node set --preset` then let single keys override it.
 */
import { CliError, EXIT } from "./errors.ts";
import { isObject, leavesOfSpec } from "./paths.ts";
import type { Json, JsonObject } from "./types.ts";

export type ParamKind = "string" | "string[]" | "number" | "object" | "object[]";

export interface PresetParam {
  kind: ParamKind;
  desc: string;
  required?: boolean;
}

export interface Preset {
  name: string;
  desc: string;
  params: Record<string, PresetParam>;
  /** Parameters for the example `knime nodes info` shows. */
  example: Record<string, Json>;
  build(params: Record<string, Json>): JsonObject;
}

const typed = (type: string, value: Json): JsonObject => ({ $type: type, value });
const strs = (v: Json | undefined): string[] => (Array.isArray(v) ? v.map(String) : []);

/**
 * Full settings for a treeensemble2 regression learner. A fresh node's read stops after nrModels (its save throws on
 * the null split criterion), so every later key is created with a typed value, all in one set.
 */
function treeBase(p: Record<string, Json>): JsonObject {
  const target = String(p.target);
  const features = strs(p.features);
  const exclude = [...new Set([target, ...strs(p.exclude)])];
  return {
    targetColumn: target,
    seed: p.seed === undefined ? "42" : p.seed === null ? null : String(p.seed),
    maxLevels: -1,
    minNodeSize: -1,
    minChildSize: -1,
    dataFraction: 1.0,
    isDataSelectionWithReplacement: false,
    columnSamplingMode: "None",
    columnFractionPerTree: 1.0,
    columnAbsolutePerTree: 10,
    isUseDifferentAttributesAtEachNode: false,
    nrModels: 100,
    splitCriterion: typed("string", "InformationGainRatio"), // ignored for regression, but must parse
    missingValueHandling: typed("string", "XGBoost"),
    useAverageSplitPoints: typed("boolean", true),
    useBinaryNominalSplits: typed("boolean", true),
    fingerprintColumn: typed("string", null),
    columnFilterConfig: typed("config", {
      "filter-type": "STANDARD",
      included_names: typed("string[]", features),
      excluded_names: typed("string[]", features.length ? [] : exclude),
      enforce_option: features.length ? "EnforceInclusion" : "EnforceExclusion",
    }),
    ignoreColumnsWithoutDomain: typed("boolean", true),
    nrHilitePatterns: typed("int", -1),
    saveTargetDistributionInNodes: typed("boolean", false),
    rowSamplingMode: typed("string", "Random"),
  };
}

const TREE_PARAMS: Record<string, PresetParam> = {
  target: { kind: "string", required: true, desc: "column to predict" },
  features: { kind: "string[]", desc: "feature columns (EnforceInclusion); default: every column except target and exclude" },
  exclude: { kind: "string[]", desc: "columns that must not be features (the target is always excluded)" },
  seed: { kind: "string", desc: "random seed as a decimal string (default \"42\"; null for a new seed per run)" },
};

const TREE_EXAMPLE = { target: "median_house_value", exclude: ["ocean_proximity"] };

const predictorName = (alias: string): Preset => ({
  name: "named", desc: "Name the prediction column (settings appear once the model input is connected)",
  params: { name: { kind: "string", required: true, desc: "prediction column name" } },
  example: { name: "pred_rf" },
  build: (p) => ({
    changePredictionColumnName: true,
    predictionColumnName: String(p.name),
    ...(alias === "rtree-predict" ? {} : { appendPredictionConfidence: false }),
  }),
});

export const PRESETS: Record<string, Preset[]> = {
  "rf-learn": [{
    name: "regression", desc: "Random forest regression, as tuned on California housing (300 trees, Linear 0.33 per node, R² 0.832)",
    params: TREE_PARAMS, example: TREE_EXAMPLE,
    build: (p) => ({
      ...treeBase(p),
      nrModels: 300, minChildSize: 2, isDataSelectionWithReplacement: true,
      columnSamplingMode: "Linear", columnFractionPerTree: 0.33, isUseDifferentAttributesAtEachNode: true,
    }),
  }],
  "gbt-learn": [{
    name: "regression", desc: "Gradient boosted trees regression: depth 4, learning rate 0.1, full data (raise nrModels to 1000 for R² 0.847)",
    params: TREE_PARAMS, example: TREE_EXAMPLE,
    build: (p) => ({
      ...treeBase(p),
      maxLevels: 4, nrModels: 100,
      learningRate: typed("double", 0.1),
      alphaFraction: typed("double", 0.95), // must stay below 1
    }),
  }],
  "rtree-learn": [{
    name: "regression", desc: "Single regression tree: depth 12, minNodeSize 20, minChildSize 10",
    params: TREE_PARAMS, example: TREE_EXAMPLE,
    build: (p) => ({ ...treeBase(p), maxLevels: 12, minNodeSize: 20, minChildSize: 10 }),
  }],
  "rf-predict": [predictorName("rf-predict")],
  "gbt-predict": [predictorName("gbt-predict")],
  "rtree-predict": [predictorName("rtree-predict")],
  "reg-predict": [{
    name: "named", desc: "Name the prediction column",
    params: { name: { kind: "string", required: true, desc: "prediction column name" } },
    example: { name: "pred_linear" },
    build: (p) => ({ has_custom_predicition_name: true, custom_prediction_name: String(p.name) }),
  }],
  groupby: [{
    name: "aggregate", desc: "Group by columns and aggregate others (outputs <Method>(<col>); Count is Count*(<col>))",
    params: {
      groupBy: { kind: "string[]", required: true, desc: "group columns" },
      aggregations: {
        kind: "object[]", required: true,
        desc: "[{column, method, cellClass?}]: method ids such as Count or Mean_V4.6; cellClass defaults to org.knime.core.data.def.DoubleCell",
      },
    },
    example: { groupBy: ["ocean_proximity"], aggregations: [{ column: "median_house_value", method: "Count" }, { column: "median_house_value", method: "Mean_V4.6" }] },
    build: (p) => {
      const aggs = (p.aggregations as JsonObject[]).map((a) => ({
        column: String(a.column), method: String(a.method),
        cellClass: String(a.cellClass ?? "org.knime.core.data.def.DoubleCell"),
      }));
      return {
        grouByColumns: { InclList: strs(p.groupBy) },
        aggregationColumn: {
          columnNames: aggs.map((a) => a.column),
          columnTypes: typed("config[]", aggs.map((a) => ({ cell_class: a.cellClass, is_null: false }))),
          aggregationMethod: aggs.map((a) => a.method),
          inclMissingVals: typed("boolean[]", aggs.map(() => false)),
        },
      };
    },
  }],
  "column-renamer": [{
    name: "rename", desc: "Rename columns; a wrong old name is silently passed through, so check names exactly",
    params: { renames: { kind: "object", required: true, desc: "{\"old name\": \"new name\", …}" } },
    example: { renames: { "Count*(median_house_value)": "count", "Mean(median_house_value)": "mean_house_value" } },
    build: (p) => ({
      renamings: Object.fromEntries(Object.entries(p.renames as JsonObject).map(([oldName, newName], i) => [
        String(i), typed("config", { oldName, newName: String(newName) }),
      ])),
    }),
  }],
};

export function presetsFor(alias: string | undefined): Preset[] {
  return alias ? PRESETS[alias] ?? [] : [];
}

export type PresetRef = string | ({ name: string } & Record<string, Json>);

function kindOf(v: Json): ParamKind | "other" {
  if (typeof v === "string" || v === null) return "string";
  if (typeof v === "number") return "number";
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? "string[]" : v.every(isObject) ? "object[]" : "other";
  if (isObject(v)) return "object";
  return "other";
}

/** Builds a preset from a reference; throws USAGE naming what's wrong. */
export function buildPreset(alias: string | undefined, ref: PresetRef): { preset: Preset; settings: JsonObject } {
  const { name, ...params } = typeof ref === "string" ? { name: ref } : ref;
  const list = presetsFor(alias);
  const preset = list.find((p) => p.name === name);
  const fail = (message: string) => new CliError({
    code: "BAD_PRESET", exit: EXIT.USAGE, message,
    hint: alias ? `See \`knime nodes info ${alias}\` for its presets and parameters.` : "Presets need a catalogue alias.",
  });
  if (!preset) {
    throw fail(`${alias ?? "this node"} has no preset "${name}"${list.length ? `; it has: ${list.map((p) => p.name).join(", ")}` : ""}`);
  }
  for (const [k, spec] of Object.entries(preset.params)) {
    if (spec.required && params[k] === undefined) throw fail(`preset ${alias}:${name} needs "${k}" (${spec.desc})`);
  }
  for (const [k, v] of Object.entries(params)) {
    const spec = preset.params[k];
    if (!spec) throw fail(`preset ${alias}:${name} has no parameter "${k}"; it takes ${Object.keys(preset.params).join(", ")}`);
    const kind = kindOf(v as Json);
    if (kind !== spec.kind && !(spec.kind === "string" && kind === "number")) {
      throw fail(`preset ${alias}:${name} parameter "${k}" must be ${spec.kind}, got ${JSON.stringify(v)}`);
    }
  }
  return { preset, settings: preset.build(params as Record<string, Json>) };
}

/**
 * Applies override settings (nested or dot-path keys) on top of a preset. Overrides descend into typed configs, and a
 * plain override of a typed preset leaf keeps the preset's type (so `learningRate: 0.05` stays a double that the
 * server can create on a fresh node).
 */
export function overlay(base: JsonObject, overrides: JsonObject): JsonObject {
  const out = structuredClone(base);
  for (const leaf of leavesOfSpec(overrides)) {
    let cur: JsonObject = out;
    for (const [i, k] of leaf.keys.entries()) {
      const last = i === leaf.keys.length - 1;
      const existing = cur[k];
      if (last) {
        const typedBase = isObject(existing) && "$type" in existing;
        const typedOverride = isObject(leaf.value) && "$type" in leaf.value;
        cur[k] = typedBase && !typedOverride && existing.$type !== "config"
          ? { $type: existing.$type ?? null, value: leaf.value } : leaf.value;
        break;
      }
      if (isObject(existing) && existing.$type === "config" && isObject(existing.value)) {
        cur = existing.value;
      } else if (isObject(existing) && !("$type" in existing)) {
        cur = existing;
      } else {
        const created: JsonObject = {};
        cur[k] = created;
        cur = created;
      }
    }
  }
  return out;
}
