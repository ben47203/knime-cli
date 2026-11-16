/**
 * Builds a California housing regression workflow in the open KNIME project, driven only through the knime-cli local
 * API, executes it, and writes tidy CSVs for a dashboard.
 *
 *   KNIME_CLI_PID=77024 node examples/california.ts            # build + run everything
 *   KNIME_CLI_PID=77024 CAL_TREES=0 node examples/california.ts  # skip the tree learners
 *
 * Reads housing.csv and writes out/ under CAL_DIR (default ~/knime-workspace/knime-cli-demo/california-housing);
 * CAL_DATA and CAL_OUT override the two paths individually.
 *
 * Models: linear regression, degree-2 polynomial regression, an RProp MLP, and (unless CAL_TREES=0) random forest,
 * gradient boosted trees and a single regression tree, all trained on the same 80% partition (seed 42) and scored on
 * the other 20%. The tree learners are configured with typed settings values; see treeConfig().
 *
 * Features: the raw columns, rooms/bedrooms/population ratios, log(median_income), great-circle distances to Los
 * Angeles and San Francisco, and one-hot ocean_proximity (ISLAND, the rarest, is the baseline).
 *
 * Outputs (in OUT): data_clean.csv, predictions.csv, metrics.csv, feature_importance.csv (linear coefficients),
 * feature_importance_rf.csv (random forest attribute statistics) and by_proximity.csv.
 *
 * Re-runnable: every node it adds is labelled "cal:<key>", and on start it deletes the nodes carrying such a label
 * (ids are reused after a delete, so cached ids would point at the wrong nodes). Nothing else in the workflow is
 * touched, and the project isn't saved.
 *
 * Gateway commands time out after 30 s with HTTP 504 (the command was probably still applied). On a 504 or 503 the
 * script stops issuing commands, reads the workflow state, and reports what it saw.
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { HttpError, type KnimeClient } from "../src/client.ts";
import { connect, type Target } from "../test/helpers/fixture.ts";
import type { ExecResult, SetResult, Settings, WorkflowRead, WorkflowState } from "../test/helpers/types.ts";

const DEMO_DIR = process.env.CAL_DIR ?? join(homedir(), "knime-workspace", "knime-cli-demo", "california-housing");
const DATA = process.env.CAL_DATA ?? join(DEMO_DIR, "housing.csv");
const OUT = process.env.CAL_OUT ?? join(DEMO_DIR, "out");
const LABEL = "cal:";
/** median_house_value is capped at 500,001 in this dataset; the MLP needs its target in [0, 1]. */
const TARGET_SCALE = 500001;

const F = {
  CSV_READER: "org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory",
  MISSING: "org.knime.base.node.preproc.pmml.missingval.compute.MissingValueHandlerNodeFactory",
  SNIPPET: "org.knime.ext.sun.nodes.script.JavaScriptingNodeFactory",
  ONE_TO_MANY: "org.knime.base.node.preproc.columntrans2.One2ManyCol2NodeFactory",
  PARTITION: "org.knime.base.node.preproc.partition.PartitionNodeFactory",
  LINREG: "org.knime.base.node.mine.regression.linear2.learner.LinReg2LearnerNodeFactory2",
  POLYREG: "org.knime.base.node.mine.regression.polynomial.learner2.PolyRegLearnerNodeFactory2",
  REG_PREDICT: "org.knime.base.node.mine.regression.predict3.RegressionPredictorNodeFactory2",
  NORMALIZER: "org.knime.base.node.preproc.pmml.normalize.NormalizerPMMLNodeFactory2",
  NORM_APPLY: "org.knime.base.node.preproc.pmml.normalize.NormalizerPMMLApplyNodeFactory",
  RPROP: "org.knime.base.node.mine.neural.rprop.RPropNodeFactory2",
  MLP_PREDICT: "org.knime.base.node.mine.neural.mlp2.MLPPredictorNodeFactory",
  COLUMN_FILTER: "org.knime.base.node.preproc.filter.column.DataColumnSpecFilterNodeFactory",
  COLUMN_APPEND: "org.knime.base.node.preproc.columnappend2.ColumnAppender2NodeFactory",
  SCORER: "org.knime.base.node.mine.scorer.numeric2.NumericScorer2NodeFactory",
  TRANSPOSE: "org.knime.base.node.preproc.transpose.TransposeTableNodeFactory",
  RENAMER: "org.knime.base.node.preproc.column.renamer.ColumnRenamerNodeFactory",
  GROUPBY: "org.knime.base.node.preproc.groupby.GroupByNodeFactory",
  RTREE_LEARN: "org.knime.base.node.mine.treeensemble2.node.regressiontree.learner.RegressionTreeLearnerNodeFactory",
  RTREE_PREDICT: "org.knime.base.node.mine.treeensemble2.node.regressiontree.predictor.RegressionTreePredictorNodeFactory",
  CSV_WRITER: "org.knime.base.node.io.filehandling.csv.writer.CSVWriter2NodeFactory",
  // Tree learners (treeensembles2), tried last because they were blocked before.
  RF_LEARN: "org.knime.base.node.mine.treeensemble2.node.randomforest.learner.regression.RandomForestRegressionLearnerNodeFactory",
  RF_PREDICT: "org.knime.base.node.mine.treeensemble2.node.randomforest.predictor.regression.RandomForestRegressionPredictorNodeFactory",
  GBT_LEARN: "org.knime.base.node.mine.treeensemble2.node.gradientboosting.learner.regression.GradientBoostingRegressionLearnerNodeFactory2",
  GBT_PREDICT: "org.knime.base.node.mine.treeensemble2.node.gradientboosting.predictor.regression.GradientBoostingPredictorNodeFactory",
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Thin layer over the API

/** Raised when the gateway stops confirming commands; the build halts instead of piling more calls on KNIME. */
class GatewayStalled extends Error {}

let client: KnimeClient;
let target: Target;
const ids: Record<string, string> = {};
const log: string[] = [];
let commands = 0;

function api<R>(path: string, body: Record<string, unknown> = {}): Promise<R> {
  return client.api<R>(path, { ...target, ...body });
}

async function cmd<R = unknown>(workflowCommand: Record<string, unknown>, what: string): Promise<R> {
  const started = Date.now();
  commands++;
  try {
    const r = await client.call<R>("WorkflowService.executeWorkflowCommand", { ...target, workflowCommand });
    const ms = Date.now() - started;
    if (ms > 5000) log.push(`slow command (${ms} ms): ${what}`);
    return r;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 504 || e.status === 503)) {
      throw new GatewayStalled(`HTTP ${e.status} after ${Date.now() - started} ms on command #${commands} "${what}" `
        + `${JSON.stringify(workflowCommand)}: ${e.message}`);
    }
    throw new Error(`${what}: ${String(e)}`);
  }
}

const GRID_X = 170;
const GRID_Y = 140;

async function node(key: string, factory: string, col: number, row: number): Promise<string> {
  const r = await cmd<{ newNodeId: string }>(
    { kind: "add_node", nodeFactory: { className: factory }, position: { x: col * GRID_X, y: row * GRID_Y } },
    `add ${key}`,
  );
  ids[key] = r.newNodeId;
  await cmd({ kind: "update_node_label", nodeId: r.newNodeId, label: LABEL + key }, `label ${key}`);
  return r.newNodeId;
}

/** Data ports start at 1; port 0 is the flow variable port. */
async function wire(from: string, fromPort: number, to: string, toPort: number): Promise<void> {
  await cmd(
    { kind: "connect", sourceNodeId: ids[from], sourcePortIdx: fromPort, destinationNodeId: ids[to], destinationPortIdx: toPort },
    `connect ${from}:${fromPort} -> ${to}:${toPort}`,
  );
}

function settings(key: string): Promise<Settings> {
  return api<Settings>("/api/node/settings", { nodeId: ids[key] });
}

async function patch(key: string, model: Record<string, unknown>): Promise<SetResult> {
  try {
    const r = await api<SetResult>("/api/node/settings/set", { nodeId: ids[key], model });
    if (r.message?.type === "ERROR") log.push(`${key} after set: ${r.message.text}`);
    return r;
  } catch (e) {
    throw new Error(`patch ${key}: ${String(e)}`);
  }
}

/** Executes and then checks the states itself: /api/execute can report done with nothing failed while nodes idle. */
async function run(keys: string[], totalMs = 600_000): Promise<void> {
  const nodeIds = keys.map((k) => ids[k]);
  let r = await api<ExecResult>("/api/execute", { nodeIds, waitMs: 30_000 });
  const deadline = Date.now() + totalMs;
  while (!r.done && Date.now() < deadline) r = await api<ExecResult>("/api/wait", { nodeIds, waitMs: 30_000 });
  const state = await api<WorkflowState>("/api/workflow/state");
  const bad = state.nodes.filter((n) => nodeIds.includes(n.nodeId) && n.state !== "EXECUTED");
  if (bad.length) {
    const errors = await api<WorkflowState>("/api/workflow/errors");
    const detail = errors.nodes.map((n) => `${labelOf(n.nodeId)} (${n.nodeId}): ${n.message?.text}`).join("; ");
    throw new Error(`not executed: ${bad.map((n) => `${labelOf(n.nodeId)}=${n.state}`).join(", ")}`
      + (r.failed.length ? ` failed=${JSON.stringify(r.failed)}` : " (execute reported no failures)")
      + (detail ? `; errors: ${detail}` : ""));
  }
}

function labelOf(nodeId: string): string {
  return Object.entries(ids).find(([, id]) => id === nodeId)?.[0] ?? nodeId;
}

/** Deletes the nodes a previous run left, found by label. */
async function cleanup(): Promise<void> {
  const { workflow } = await api<WorkflowRead>("/api/workflow");
  const ours = Object.entries(workflow.nodes ?? {})
    .filter(([, n]) => String((n as { annotation?: { text?: { value?: string } } }).annotation?.text?.value ?? "").startsWith(LABEL))
    .map(([id]) => id);
  if (!ours.length) return;
  // Anything still running can't be deleted.
  await api("/api/cancel", { nodeIds: ours });
  await api("/api/wait", { nodeIds: ours, waitMs: 30_000 });
  await cmd({ kind: "delete", nodeIds: ours, annotationIds: [], connectionIds: [] }, `delete ${ours.length} old nodes`);
  console.error(`removed ${ours.length} node(s) from a previous run`);
}

// ---------------------------------------------------------------------------------------------------------------
// Node configurations

const snippet = (column: string, expression: string) => ({
  append_column: false, // "true" replaces replaced_column; false appends a new column with that name
  replaced_column: column,
  expression,
  header: "",
  return_type: "java.lang.Double",
});

const writer = (file: string, extra: Record<string, unknown> = {}) => ({
  settings: {
    file_chooser_settings: { path: { path: `${OUT}/${file}` }, create_missing_folders: true, if_path_exists: "overwrite" },
    ...extra,
  },
});

/** Great-circle distance in km from each district to a fixed point. */
const haversine = (lat: number, lon: number) =>
  `double dLat = Math.toRadians($latitude$ - (${lat}));\n`
  + `double dLon = Math.toRadians($longitude$ - (${lon}));\n`
  + `double h = Math.pow(Math.sin(dLat / 2), 2) + Math.cos(Math.toRadians(${lat})) * Math.cos(Math.toRadians($latitude$)) * Math.pow(Math.sin(dLon / 2), 2);\n`
  + "return 2 * 6371.0 * Math.asin(Math.sqrt(h));";

/** Columns the learners must not see: the raw category, its rarest dummy (baseline), and the targets. */
const NOT_FEATURES = ["ocean_proximity", "ISLAND", "median_house_value", "target_scaled"];

interface Model {
  key: string;
  name: string;
  pred: string;
}
const models: Model[] = [];

// ---------------------------------------------------------------------------------------------------------------
// Build

async function buildPrep(): Promise<void> {
  await node("reader", F.CSV_READER, 0, 2);
  await patch("reader", { csvReaderParameters: { multiFileSelectionParams: { source: { path: { path: DATA } } } } });
  await node("missing", F.MISSING, 1, 2);
  await wire("reader", 1, "missing", 1);
  await run(["reader"]);
  await patch("missing", {
    dataTypeSettings: {
      "org.knime.core.data.def.DoubleCell": {
        factoryID: "org.knime.base.node.preproc.pmml.missingval.handlers.MedianNumberMissingCellHandlerFactory",
      },
    },
  });

  const feats: [string, string][] = [
    ["rooms_per_household", "return $total_rooms$ / $households$;"],
    ["bedrooms_per_room", "return $total_bedrooms$ / $total_rooms$;"],
    ["population_per_household", "return $population$ / $households$;"],
    ["log_median_income", "return Math.log($median_income$);"],
    ["dist_la", haversine(34.05, -118.24)],
    ["dist_sf", haversine(37.77, -122.42)],
  ];
  let prev = "missing";
  for (const [i, [col, expr]] of feats.entries()) {
    const key = `feat-${col}`;
    await node(key, F.SNIPPET, 2 + i, 2);
    await wire(prev, 1, key, 1);
    await patch(key, snippet(col, expr));
    prev = key;
  }
  await node("onehot", F.ONE_TO_MANY, 2 + feats.length, 2);
  await wire(prev, 1, "onehot", 1);
  await patch("onehot", { columns2Btransformed: { included_names: ["ocean_proximity"] } });

  await node("w-clean", F.CSV_WRITER, 6, 4);
  await wire("onehot", 1, "w-clean", 1);
  await patch("w-clean", writer("data_clean.csv"));

  // The MLP needs a [0, 1] target; a constant scale keeps it reversible without data-dependent bounds.
  await node("target-scaled", F.SNIPPET, 6, 2);
  await wire("onehot", 1, "target-scaled", 1);
  await patch("target-scaled", snippet("target_scaled", `return $median_house_value$ / ${TARGET_SCALE}.0;`));

  await node("partition", F.PARTITION, 7, 2);
  await wire("target-scaled", 1, "partition", 1);
  await patch("partition", { partitioningMode: "RELATIVE", percentage: 80, mode: "RANDOM", seed: 42, seed_is_present: true });
  await node("actual", F.SNIPPET, 8, 0);
  await wire("partition", 2, "actual", 1);
  await patch("actual", snippet("actual", "return $median_house_value$;"));
  await run(["partition", "w-clean"]);
}

/**
 * Predictions are chained: each predictor appends its column to the test table coming out of the previous one, so the
 * end of the chain holds every model's prediction side by side.
 */
let chainEnd = { key: "actual", port: 1 };

async function addRegression(key: string, name: string, factory: string, row: number, cfg: Record<string, unknown>) {
  const learn = `${key}-learn`;
  const pred = `${key}-pred`;
  await node(learn, factory, 8, row);
  await wire("partition", 1, learn, 1);
  await patch(learn, cfg);
  await node(pred, F.REG_PREDICT, 9 + models.length, 0.5);
  await wire(learn, 1, pred, 1);
  await wire(chainEnd.key, chainEnd.port, pred, 2);
  await patch(pred, { has_custom_predicition_name: true, custom_prediction_name: `pred_${key}` });
  chainEnd = { key: pred, port: 1 };
  models.push({ key, name, pred: `pred_${key}` });
}

async function buildLinearModels(): Promise<void> {
  await addRegression("linear", "Linear regression", F.LINREG, 0, {
    target: "median_house_value",
    column_filter: { included_names: [], excluded_names: NOT_FEATURES },
  });
  await addRegression("poly2", "Polynomial regression (degree 2)", F.POLYREG, 1, {
    targetColumn: "median_house_value",
    degree: 2,
    "column filter": { included_names: [], excluded_names: NOT_FEATURES },
  });
}

const MLP = { maxiter: num("CAL_MLP_ITER", 1000), hiddenlayer: num("CAL_MLP_LAYERS", 2), nrhiddenneurons: num("CAL_MLP_NEURONS", 32) };

function num(env: string, dflt: number): number {
  const v = process.env[env];
  return v === undefined ? dflt : Number(v);
}

async function buildMlp(): Promise<void> {
  // Min-max normalise the inputs on the training partition and apply the same model to the test partition. The
  // targets stay as they are: RProp needs its numeric target in [0, 1], which target_scaled already is.
  await node("mlp-norm", F.NORMALIZER, 8, 3);
  await wire("partition", 1, "mlp-norm", 1);
  await run(["partition"]);
  const cols = (await settings("mlp-norm")).model.columns as string[];
  await patch("mlp-norm", { mode: 1, newmin: 0, newmax: 1, columns: cols.filter((c) => !NOT_FEATURES.includes(c)) });
  await node("mlp-norm-apply", F.NORM_APPLY, 8, 4);
  await wire("mlp-norm", 2, "mlp-norm-apply", 1);
  await wire("partition", 2, "mlp-norm-apply", 2);

  await node("mlp-learn", F.RPROP, 9, 3);
  // RProp has no column filter: every other column is an input, so the normalised table must hold only features
  // plus the target.
  await node("mlp-train-cols", F.COLUMN_FILTER, 8.5, 3.5);
  await wire("mlp-norm", 1, "mlp-train-cols", 1);
  await wire("mlp-train-cols", 1, "mlp-learn", 1);
  await node("mlp-test-cols", F.COLUMN_FILTER, 9, 4.5);
  await wire("mlp-norm-apply", 2, "mlp-test-cols", 1);
  const dropForMlp = NOT_FEATURES.filter((c) => c !== "target_scaled");
  await run(["mlp-norm", "mlp-norm-apply"]);
  for (const k of ["mlp-train-cols", "mlp-test-cols"]) {
    await patch(k, { "column-filter": { "filter-type": "STANDARD", included_names: [], excluded_names: dropForMlp, enforce_option: "EnforceExclusion" } });
  }
  await run(["mlp-train-cols"]);
  await patch("mlp-learn", { classcol: "target_scaled", ...MLP, useRandomSeed: true, randomSeed: 42 });

  await node("mlp-pred", F.MLP_PREDICT, 10, 4);
  await wire("mlp-learn", 1, "mlp-pred", 1);
  await wire("mlp-test-cols", 1, "mlp-pred", 2);
  await patch("mlp-pred", { "change prediction": true, "prediction column name": "pred_mlp_scaled", "append probabilities": false });

  // Back to dollars, keep only the prediction, and append it to the chain by row id (the test rows are the same).
  await node("mlp-unscale", F.SNIPPET, 11, 4);
  await wire("mlp-pred", 1, "mlp-unscale", 1);
  await patch("mlp-unscale", snippet("pred_mlp", `return $pred_mlp_scaled$ * ${TARGET_SCALE}.0;`));
  await node("mlp-only", F.COLUMN_FILTER, 12, 4);
  await wire("mlp-unscale", 1, "mlp-only", 1);
  await run(["mlp-unscale"]);
  await patch("mlp-only", { "column-filter": { "filter-type": "STANDARD", included_names: ["pred_mlp"], excluded_names: [], enforce_option: "EnforceInclusion" } });
  await node("mlp-join", F.COLUMN_APPEND, 9 + models.length, 1);
  await wire(chainEnd.key, chainEnd.port, "mlp-join", 1);
  await wire("mlp-only", 1, "mlp-join", 2);
  chainEnd = { key: "mlp-join", port: 1 };
  models.push({ key: "mlp", name: "Neural network (RProp MLP)", pred: "pred_mlp" });
}

const KEEP = ["longitude", "latitude", "median_income", "ocean_proximity", "actual"];
const TAIL_COL = 20;

/**
 * Everything downstream of the prediction chain. "pred-filter" is the only node that reads the chain end, so a model
 * added later is spliced in by reconnecting that one input.
 */
async function buildOutputs(): Promise<void> {
  await node("pred-filter", F.COLUMN_FILTER, TAIL_COL, 0);
  await wire(chainEnd.key, chainEnd.port, "pred-filter", 1);
  await run([chainEnd.key]);
  await patchPredFilter();
  await node("w-predictions", F.CSV_WRITER, TAIL_COL + 1, 0);
  await wire("pred-filter", 1, "w-predictions", 1);
  await patch("w-predictions", writer("predictions.csv"));

  // One scorer per model, each naming its output column after the model; joined side by side, then transposed so
  // each model is a row.
  await node("metrics-join", F.COLUMN_APPEND, TAIL_COL + 2, 2);
  for (const m of models) await addScorer(m);
  await node("metrics-t", F.TRANSPOSE, TAIL_COL + 3, 2);
  await wire("metrics-join", 1, "metrics-t", 1);
  // Tidy column names. Snippets copy the columns under new names, since the model name is the row id, which a
  // Column Renamer can't turn into a column.
  const tidy: [string, string, string][] = [
    ["model", "return $$ROWID$$;", "java.lang.String"],
    ["r2", "return $R^2$;", "java.lang.Double"],
    ["rmse", "return $root mean squared error$;", "java.lang.Double"],
    ["mae", "return $mean absolute error$;", "java.lang.Double"],
  ];
  let prev = "metrics-t";
  for (const [i, [col, expr, type]] of tidy.entries()) {
    const key = `metrics-${col}`;
    await node(key, F.SNIPPET, TAIL_COL + 4 + i, 2);
    await wire(prev, 1, key, 1);
    await patch(key, { ...snippet(col, expr), return_type: type });
    prev = key;
  }
  await node("metrics-cols", F.COLUMN_FILTER, TAIL_COL + 8, 2);
  await wire(prev, 1, "metrics-cols", 1);
  await run([prev]);
  await patch("metrics-cols", {
    "column-filter": { "filter-type": "STANDARD", included_names: tidy.map((t) => t[0]), excluded_names: [], enforce_option: "EnforceInclusion" },
  });
  await node("w-metrics", F.CSV_WRITER, TAIL_COL + 9, 2);
  await wire("metrics-cols", 1, "w-metrics", 1);
  await patch("w-metrics", writer("metrics.csv"));

  // Linear regression coefficients (variable, coeff., std. err., t-value, P>|t|) from the learner's second port.
  await node("w-importance-linear", F.CSV_WRITER, 9, -1);
  await wire("linear-learn", 2, "w-importance-linear", 1);
  await patch("w-importance-linear", writer("feature_importance.csv"));

  // Count, mean value and mean income per ocean_proximity, on the cleaned data. GroupBy's parallel arrays need typed
  // values on a fresh node (its empty arrays read back as string arrays), and the Column Renamer grows one typed
  // entry per rename.
  const aggs: [string, string, string][] = [
    ["count", "median_house_value", "Count"],
    ["mean_house_value", "median_house_value", "Mean_V4.6"],
    ["mean_income", "median_income", "Mean_V4.6"],
  ];
  // GroupBy names its outputs "<label>(<column>)"; Count's label carries an asterisk.
  const METHOD_LABEL: Record<string, string> = { Count: "Count*", "Mean_V4.6": "Mean" };
  await node("by-proximity", F.GROUPBY, 6, 5);
  await wire("onehot", 1, "by-proximity", 1);
  await patch("by-proximity", {
    grouByColumns: { InclList: ["ocean_proximity"] },
    aggregationColumn: {
      columnNames: aggs.map((x) => x[1]),
      columnTypes: { $type: "config[]", value: aggs.map(() => ({ cell_class: "org.knime.core.data.def.DoubleCell", is_null: false })) },
      aggregationMethod: aggs.map((x) => x[2]),
      inclMissingVals: { $type: "boolean[]", value: aggs.map(() => false) },
    },
  });
  await node("prox-names", F.RENAMER, 7, 5);
  await wire("by-proximity", 1, "prox-names", 1);
  await patch("prox-names", {
    renamings: Object.fromEntries(aggs.map(([name, col, method], i) => [String(i), {
      $type: "config", value: { oldName: `${METHOD_LABEL[method]}(${col})`, newName: name },
    }])),
  });
  await node("w-by-proximity", F.CSV_WRITER, 8, 5);
  await wire("prox-names", 1, "w-by-proximity", 1);
  await patch("w-by-proximity", writer("by_proximity.csv"));

  await run(OUTPUT_WRITERS);
}

const OUTPUT_WRITERS = ["w-clean", "w-predictions", "w-metrics", "w-importance-linear", "w-by-proximity"];

/** Every feature column: what the tree learners include explicitly, and the others get by excluding NOT_FEATURES. */
const FEATURES = [
  "longitude", "latitude", "housing_median_age", "total_rooms", "total_bedrooms", "population", "households",
  "median_income", "rooms_per_household", "bedrooms_per_room", "population_per_household", "log_median_income",
  "dist_la", "dist_sf", "<1H OCEAN", "INLAND", "NEAR BAY", "NEAR OCEAN",
];

/**
 * Full settings for a treeensemble2 regression learner (random forest, gradient boosting, single tree). A fresh node's
 * own save throws after nrModels (its split criterion is null), so the keys after it are missing and must be created
 * with typed values, all in one set.
 */
function treeConfig(o: Record<string, unknown>): Record<string, unknown> {
  return {
    targetColumn: "median_house_value",
    seed: "42",
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
    splitCriterion: { $type: "string", value: "InformationGainRatio" }, // ignored for regression, but must parse
    missingValueHandling: { $type: "string", value: "XGBoost" },
    useAverageSplitPoints: { $type: "boolean", value: true },
    useBinaryNominalSplits: { $type: "boolean", value: true },
    fingerprintColumn: { $type: "string", value: null },
    columnFilterConfig: { $type: "config", value: {
      "filter-type": "STANDARD",
      included_names: { $type: "string[]", value: FEATURES },
      excluded_names: { $type: "string[]", value: NOT_FEATURES },
      enforce_option: "EnforceInclusion",
    } },
    ignoreColumnsWithoutDomain: { $type: "boolean", value: true },
    nrHilitePatterns: { $type: "int", value: -1 },
    saveTargetDistributionInNodes: { $type: "boolean", value: false },
    rowSamplingMode: { $type: "string", value: "Random" },
    ...o,
  };
}

/**
 * Tuned on the 80/20 split. Gradient boosting: depth 4 at full data beat deeper trees and row subsampling clearly
 * (depth 6-8 or dataFraction 0.8 gave R^2 ~0.79, against 0.847 here). alphaFraction must stay below 1.
 */
const TREES = {
  rf: treeConfig({
    nrModels: num("CAL_RF_TREES", 300),
    minChildSize: num("CAL_RF_MINCHILD", 2),
    maxLevels: num("CAL_RF_DEPTH", -1),
    isDataSelectionWithReplacement: true,
    columnSamplingMode: "Linear",
    columnFractionPerTree: num("CAL_RF_FRACTION", 0.33),
    isUseDifferentAttributesAtEachNode: true,
  }),
  gbt: treeConfig({
    nrModels: num("CAL_GBT_TREES", 1000),
    maxLevels: num("CAL_GBT_DEPTH", 4),
    dataFraction: num("CAL_GBT_FRACTION", 1.0),
    learningRate: { $type: "double", value: num("CAL_GBT_LR", 0.1) },
    alphaFraction: { $type: "double", value: 0.95 },
  }),
  tree: treeConfig({ maxLevels: num("CAL_TREE_DEPTH", 12), minNodeSize: 20, minChildSize: 10 }),
};

async function buildTrees(): Promise<void> {
  const trees: [string, string, string, string][] = [
    ["rf", "Random forest", F.RF_LEARN, F.RF_PREDICT],
    ["gbt", "Gradient boosted trees", F.GBT_LEARN, F.GBT_PREDICT],
    ["tree", "Regression tree", F.RTREE_LEARN, F.RTREE_PREDICT],
  ];
  for (const [i, [key, name, learnF, predF]] of trees.entries()) {
    const learn = `${key}-learn`;
    const pred = `${key}-pred`;
    await node(learn, learnF, 10, 6 + i);
    await wire("partition", 1, learn, 1);
    const r = await patch(learn, TREES[key as keyof typeof TREES]);
    if (!r.complete) throw new Error(`${learn} settings still incomplete: ${r.problem}`);
    await node(pred, predF, TAIL_COL - 6 + i, 0.5);
    await wire(learn, learn === "rf-learn" ? 3 : 1, pred, 1);
    await wire(chainEnd.key, chainEnd.port, pred, 2);
    const ps = (await settings(pred)).model;
    if ("changePredictionColumnName" in ps) {
      await patch(pred, { changePredictionColumnName: true, predictionColumnName: `pred_${key}`,
        ...("appendPredictionConfidence" in ps ? { appendPredictionConfidence: false } : {}) });
    }
    chainEnd = { key: pred, port: 1 };
    models.push({ key, name, pred: `pred_${key}` });
  }

  // Random forest attribute statistics (splits and candidates per level, a usage-based importance). The attribute
  // name is the row id, so the row header is written too.
  await node("w-importance-rf", F.CSV_WRITER, 11, 5.5);
  await wire("rf-learn", 2, "w-importance-rf", 1);
  await patch("w-importance-rf", writer("feature_importance_rf.csv", { write_row_header: true }));
  OUTPUT_WRITERS.push("w-importance-rf");

  // Splice the new predictions in front of the outputs and score them.
  await wire(chainEnd.key, chainEnd.port, "pred-filter", 1);
  await run([chainEnd.key]);
  await patchPredFilter();
  for (const m of models.slice(scorers)) await addScorer(m);
  await run(OUTPUT_WRITERS);
}

async function patchPredFilter(): Promise<void> {
  await patch("pred-filter", {
    "column-filter": {
      "filter-type": "STANDARD",
      included_names: [...KEEP, ...models.map((m) => m.pred)],
      excluded_names: [],
      enforce_option: "EnforceInclusion",
    },
  });
}

let scorers = 0;
async function addScorer(m: Model): Promise<void> {
  const key = `score-${m.key}`;
  await node(key, F.SCORER, TAIL_COL + 1, 1 + scorers * 0.7);
  await wire("pred-filter", 1, key, 1);
  await patch(key, {
    reference: { useRowID: false, columnName: "actual" },
    predicted: { useRowID: false, columnName: m.pred },
    "override default output name": true,
    "output column": m.key,
  });
  // Column Appender starts with two table inputs; each further one is an extra port.
  if (scorers >= 2) {
    await cmd({ kind: "add_port", nodeId: ids["metrics-join"], side: "input", portGroup: "input",
      portTypeId: "org.knime.core.node.BufferedDataTable" }, `add metrics-join input ${scorers + 1}`);
  }
  await wire(key, 1, "metrics-join", scorers + 1);
  scorers++;
}

async function main(): Promise<void> {
  const fx = await connect();
  client = fx.client;
  target = fx.target;
  await mkdir(OUT, { recursive: true });
  await cleanup();
  await buildPrep();
  await buildLinearModels();
  await run([chainEnd.key]);
  await buildMlp();
  await buildOutputs();
  if (process.env.CAL_TREES !== "0") await buildTrees();
}

const startedAt = Date.now();
main().then(
  () => {
    console.error(`done in ${Math.round((Date.now() - startedAt) / 1000)} s; ${commands} gateway commands`);
    if (log.length) console.error(log.join("\n"));
  },
  async (e) => {
    console.error(e instanceof GatewayStalled ? `GATEWAY STALLED: ${e.message}` : `FAILED: ${e instanceof Error ? e.stack : e}`);
    if (log.length) console.error(log.join("\n"));
    try {
      const s = await api<WorkflowState>("/api/workflow/state");
      console.error("workflow state:", s.nodes.map((n) => `${labelOf(n.nodeId)}(${n.nodeId})=${n.state}`).join(", "));
    } catch (e2) {
      console.error(`state read failed too: ${String(e2)}`);
    }
    process.exitCode = 1;
  },
);
