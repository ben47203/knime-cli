/**
 * A small built-in catalogue of nodes known to work through the API, from the dogfooding runs (see CONTEXT.md and
 * ts/examples/california.ts). Port 0 is always the hidden flow-variable port and isn't listed; data ports start at 1.
 *
 * `keys` are settings paths as `knime node settings` prints them (suffixes, where the full path is long). Ports and
 * keys marked unverified are from KNIME's node descriptions, not from a run.
 */

export interface Port {
  index: number;
  name: string;
  type: "table" | "pmml" | "model" | "flow";
}

export interface CatalogueEntry {
  alias: string;
  name: string;
  factory: string;
  category: string;
  in: Port[];
  out: Port[];
  keys: Record<string, string>;
  gotchas: string[];
  /** True when ports and keys were confirmed against a running KNIME. */
  verified: boolean;
  deprecated?: string;
  /** Settings exist only after the input has a spec (true for almost every node with inputs). */
  needsInputSpec?: boolean;
  tags?: string[];
}

const T = (index: number, name: string): Port => ({ index, name, type: "table" });
const M = (index: number, name: string, type: Port["type"] = "pmml"): Port => ({ index, name, type });

const SNIPPET_KEYS = {
  expression: "Java statement(s) ending in `return …;` (hidden null on a fresh node)",
  append_column: "false = append a new column named replaced_column; true = REPLACE replaced_column (misleading name)",
  replaced_column: "the output column (new or replaced), hidden null on a fresh node",
  return_type: "e.g. java.lang.Double, java.lang.String, java.lang.Integer (hidden null)",
  header: "class-level declarations, e.g. a HashMap for running aggregates (hidden null)",
};

const FILTER = (key: string) => ({
  [`${key}.included_names`]: "string array of columns to keep",
  [`${key}.excluded_names`]: "string array of columns to drop",
  [`${key}.enforce_option`]: "EnforceInclusion (only included) or EnforceExclusion (all but excluded)",
  [`${key}.filter-type`]: "STANDARD",
});

export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    alias: "csv-reader", name: "CSV Reader", category: "IO", verified: true, tags: ["read", "file", "import"],
    factory: "org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory",
    in: [], out: [T(1, "file table")],
    keys: { "source.path.path": "local file path (full key csvReaderParameters.multiFileSelectionParams.source.path.path)" },
    gotchas: [
      "Provides a table spec only once it has run, so downstream nodes show empty settings until then.",
      "Empty fields count as missing; text NA does not, and there's no setting for a missing-value pattern.",
    ],
  },
  {
    alias: "csv-writer", name: "CSV Writer", category: "IO", verified: true, tags: ["write", "file", "export"],
    factory: "org.knime.base.node.io.filehandling.csv.writer.CSVWriter2NodeFactory",
    in: [T(1, "table to write")], out: [],
    keys: {
      "file_chooser_settings.path.path": "output file path",
      "file_chooser_settings.if_path_exists": "overwrite | append | fail",
      "file_chooser_settings.create_missing_folders": "boolean",
      write_row_header: "boolean; true to write the row ids",
    },
    gotchas: ["The only way to get data out for now: there's no table preview endpoint."],
  },
  {
    alias: "missing-value", name: "Missing Value", category: "Preprocessing", verified: true, tags: ["impute", "na", "clean"],
    factory: "org.knime.base.node.preproc.pmml.missingval.compute.MissingValueHandlerNodeFactory",
    in: [T(1, "table")], out: [T(1, "table"), M(2, "PMML missing-value model")], needsInputSpec: true,
    keys: {
      'dataTypeSettings["org.knime.core.data.def.DoubleCell"].factoryID': "handler factory class for doubles",
      'dataTypeSettings["org.knime.core.data.def.IntCell"].factoryID': "handler factory class for ints",
    },
    gotchas: [
      "Handler ids are factory class names, e.g. org.knime.base.node.preproc.pmml.missingval.handlers.MedianNumberMissingCellHandlerFactory.",
    ],
  },
  {
    alias: "column-filter", name: "Column Filter", category: "Preprocessing", verified: true, tags: ["columns", "select", "drop"],
    factory: "org.knime.base.node.preproc.filter.column.DataColumnSpecFilterNodeFactory",
    in: [T(1, "table")], out: [T(1, "filtered table")], needsInputSpec: true,
    keys: FILTER("column-filter"),
    gotchas: ["Set enforce_option explicitly; the default keeps new columns that appear upstream."],
  },
  {
    alias: "one-to-many", name: "One to Many", category: "Preprocessing", verified: true, tags: ["one-hot", "dummy", "encode"],
    factory: "org.knime.base.node.preproc.columntrans2.One2ManyCol2NodeFactory",
    in: [T(1, "table")], out: [T(1, "table with dummy columns")], needsInputSpec: true,
    keys: { "columns2Btransformed.included_names": "string array of nominal columns to one-hot encode" },
    gotchas: ["Keeps the original column; filter it out before learners that can't handle strings."],
  },
  {
    alias: "java-snippet", name: "Java Snippet (simple)", category: "Scripting", verified: true, tags: ["expression", "formula", "derive", "math"],
    factory: "org.knime.ext.sun.nodes.script.JavaScriptingNodeFactory",
    in: [T(1, "table")], out: [T(1, "table")], needsInputSpec: false,
    keys: SNIPPET_KEYS,
    gotchas: [
      "append_column: true means REPLACE; set false to append a new column.",
      "The expression needs a full statement (`return $a$ / $b$;`) or it fails with a cryptic \"~\" error.",
      "expression, header, replaced_column and return_type are hidden nulls: missing from `get`, but `set` accepts them.",
      "Rows are processed in order, so header state can hold running aggregates (the GroupBy workaround).",
    ],
  },
  {
    alias: "partition", name: "Table Partitioner", category: "Manipulation", verified: true, tags: ["split", "train", "test", "sample"],
    factory: "org.knime.base.node.preproc.partition.PartitionNodeFactory",
    in: [T(1, "table")], out: [T(1, "first partition (train)"), T(2, "second partition (test)")], needsInputSpec: false,
    keys: {
      partitioningMode: "RELATIVE | ABSOLUTE",
      percentage: "first-partition share, e.g. 80",
      mode: "RANDOM | LINEAR | STRATIFIED",
      seed: "random seed (long)",
      seed_is_present: "true to use seed",
    },
    gotchas: ["Defaults to 70% with a random seed; set percentage, seed and seed_is_present explicitly."],
  },
  {
    alias: "linreg-learn", name: "Linear Regression Learner", category: "Mining", verified: true, tags: ["regression", "linear", "learner", "model"],
    factory: "org.knime.base.node.mine.regression.linear2.learner.LinReg2LearnerNodeFactory2",
    in: [T(1, "training data")], out: [M(1, "regression model"), T(2, "coefficients and statistics")], needsInputSpec: true,
    keys: {
      target: "target column",
      "column_filter.included_names": "features (empty with excluded_names = all others)",
      "column_filter.excluded_names": "columns that must not be features (include the target)",
    },
    gotchas: ["Guesses a target column; always set target."],
  },
  {
    alias: "polyreg-learn", name: "Polynomial Regression Learner", category: "Mining", verified: true, tags: ["regression", "polynomial", "learner"],
    factory: "org.knime.base.node.mine.regression.polynomial.learner2.PolyRegLearnerNodeFactory2",
    in: [T(1, "training data")], out: [M(1, "regression model"), T(2, "coefficients")], needsInputSpec: true,
    keys: {
      targetColumn: "target column",
      degree: "polynomial degree, e.g. 2",
      '["column filter"].excluded_names': "columns that must not be features (note the space in the key)",
    },
    gotchas: ["The filter key has a space: \"column filter\"."],
  },
  {
    alias: "reg-predict", name: "Regression Predictor", category: "Mining", verified: true, tags: ["predict", "regression", "apply"],
    factory: "org.knime.base.node.mine.regression.predict3.RegressionPredictorNodeFactory2",
    in: [M(1, "regression model"), T(2, "data to predict")], out: [T(1, "data with prediction")], needsInputSpec: true,
    keys: {
      has_custom_predicition_name: "boolean (sic: 'predicition')",
      custom_prediction_name: "prediction column name (hidden null until set)",
    },
    gotchas: ["custom_prediction_name is a hidden null: not in `get`, but `set` accepts it."],
  },
  {
    alias: "normalizer", name: "Normalizer (PMML)", category: "Preprocessing", verified: true, tags: ["scale", "min-max", "z-score"],
    factory: "org.knime.base.node.preproc.pmml.normalize.NormalizerPMMLNodeFactory2",
    in: [T(1, "table")], out: [T(1, "normalised table"), M(2, "normaliser model")], needsInputSpec: true,
    keys: { mode: "1 = min-max", newmin: "e.g. 0", newmax: "e.g. 1", columns: "string array of columns to normalise" },
    gotchas: ["The model is on port 2; port 1 is the normalised table."],
  },
  {
    alias: "normalizer-apply", name: "Normalizer Apply (PMML)", category: "Preprocessing", verified: true, tags: ["scale", "apply"],
    factory: "org.knime.base.node.preproc.pmml.normalize.NormalizerPMMLApplyNodeFactory",
    in: [M(1, "normaliser model"), T(2, "table")], out: [M(1, "normaliser model"), T(2, "normalised table")],
    keys: {}, gotchas: ["The table comes out on port 2."],
  },
  {
    alias: "rprop-learn", name: "RProp MLP Learner", category: "Mining", verified: true, tags: ["neural", "mlp", "network", "learner"],
    factory: "org.knime.base.node.mine.neural.rprop.RPropNodeFactory2",
    in: [T(1, "training data")], out: [M(1, "MLP model")], needsInputSpec: true,
    keys: {
      classcol: "target column", maxiter: "iterations", hiddenlayer: "number of hidden layers",
      nrhiddenneurons: "neurons per layer", useRandomSeed: "boolean", randomSeed: "seed",
    },
    gotchas: [
      "Needs a numeric target scaled to [0,1]: add a Normalizer (min-max) or scale with a snippet.",
      "Has no column filter: every other column is an input, so filter the columns upstream.",
    ],
  },
  {
    alias: "mlp-predict", name: "MultiLayerPerceptron Predictor", category: "Mining", verified: true, tags: ["neural", "predict"],
    factory: "org.knime.base.node.mine.neural.mlp2.MLPPredictorNodeFactory",
    in: [M(1, "MLP model"), T(2, "data")], out: [T(1, "data with prediction")], needsInputSpec: true,
    keys: { '["change prediction"]': "boolean", '["prediction column name"]': "output column", '["append probabilities"]': "boolean" },
    gotchas: [],
  },
  {
    alias: "rf-learn", name: "Random Forest Learner (Regression)", category: "Mining", verified: true, tags: ["tree", "forest", "ensemble", "learner"],
    factory: "org.knime.base.node.mine.treeensemble2.node.randomforest.learner.regression.RandomForestRegressionLearnerNodeFactory",
    in: [T(1, "training data")], out: [T(1, "out-of-bag predictions"), T(2, "attribute statistics"), M(3, "forest model", "model")],
    keys: {},
    gotchas: [
      "The model is on port 3.",
      "Can't be configured through the API yet: its saved settings are cut short (null split criterion), so any patch fails. It guesses the target as the last numeric column; shape the input so that's right.",
    ],
  },
  {
    alias: "rf-predict", name: "Random Forest Predictor (Regression)", category: "Mining", verified: true, tags: ["tree", "forest", "predict"],
    factory: "org.knime.base.node.mine.treeensemble2.node.randomforest.predictor.regression.RandomForestRegressionPredictorNodeFactory",
    in: [M(1, "forest model", "model"), T(2, "data")], out: [T(1, "data with prediction")],
    keys: { changePredictionColumnName: "boolean", predictionColumnName: "output column" },
    gotchas: [],
  },
  {
    alias: "gbt-learn", name: "Gradient Boosted Trees Learner (Regression)", category: "Mining", verified: true, tags: ["tree", "boosting", "learner"],
    factory: "org.knime.base.node.mine.treeensemble2.node.gradientboosting.learner.regression.GradientBoostingRegressionLearnerNodeFactory2",
    in: [T(1, "training data")], out: [M(1, "GBT model", "model")],
    keys: {},
    gotchas: ["Use gbt-predict; the PMML predictor rejects its model.", "Unconfigurable via the API for now (cut-short settings), like the other tree learners."],
  },
  {
    alias: "gbt-predict", name: "Gradient Boosted Trees Predictor (Regression)", category: "Mining", verified: true, tags: ["tree", "boosting", "predict"],
    factory: "org.knime.base.node.mine.treeensemble2.node.gradientboosting.predictor.regression.GradientBoostingPredictorNodeFactory",
    in: [M(1, "GBT model", "model"), T(2, "data")], out: [T(1, "data with prediction")],
    keys: { changePredictionColumnName: "boolean", predictionColumnName: "output column" },
    gotchas: [],
  },
  {
    alias: "rtree-learn", name: "Simple Regression Tree Learner", category: "Mining", verified: true, tags: ["tree", "learner"],
    factory: "org.knime.base.node.mine.treeensemble2.node.regressiontree.learner.RegressionTreeLearnerNodeFactory",
    in: [T(1, "training data")], out: [M(1, "tree model", "model")],
    keys: {}, gotchas: ["Unconfigurable via the API for now (cut-short settings)."],
  },
  {
    alias: "rtree-predict", name: "Simple Regression Tree Predictor", category: "Mining", verified: true, tags: ["tree", "predict"],
    factory: "org.knime.base.node.mine.treeensemble2.node.regressiontree.predictor.RegressionTreePredictorNodeFactory",
    in: [M(1, "tree model", "model"), T(2, "data")], out: [T(1, "data with prediction")],
    keys: {}, gotchas: [],
  },
  {
    alias: "column-appender", name: "Column Appender", category: "Manipulation", verified: true, tags: ["join", "append", "combine"],
    factory: "org.knime.base.node.preproc.columnappend2.ColumnAppender2NodeFactory",
    in: [T(1, "first table"), T(2, "second table")], out: [T(1, "combined table")],
    keys: {},
    gotchas: ["Starts with two inputs; more need an add_port command (portGroup \"input\") first."],
  },
  {
    alias: "numeric-scorer", name: "Numeric Scorer", category: "Mining", verified: true, tags: ["score", "metrics", "r2", "rmse", "evaluate"],
    factory: "org.knime.base.node.mine.scorer.numeric2.NumericScorer2NodeFactory",
    in: [T(1, "table with actual and predicted")], out: [T(1, "statistics: R², MAE, MSE, RMSE, …")], needsInputSpec: true,
    keys: {
      "reference.columnName": "actual values column", "reference.useRowID": "false",
      "predicted.columnName": "prediction column", "predicted.useRowID": "false",
      '["override default output name"]': "boolean", '["output column"]': "name of the statistics column",
    },
    gotchas: [],
  },
  {
    alias: "transpose", name: "Transpose", category: "Manipulation", verified: true, tags: ["pivot", "rotate"],
    factory: "org.knime.base.node.preproc.transpose.TransposeTableNodeFactory",
    in: [T(1, "table")], out: [T(1, "transposed table")], keys: {}, gotchas: [],
  },
  {
    alias: "dedupe", name: "Duplicate Row Filter", category: "Manipulation", verified: true, tags: ["unique", "distinct", "duplicates"],
    factory: "org.knime.base.node.preproc.duplicates.DuplicateRowFilterNodeFactory",
    in: [T(1, "table")], out: [T(1, "table")], needsInputSpec: true,
    keys: {
      "group_cols.included_names": "columns that define a duplicate", row_selection: "FIRST | LAST | …",
      remove_duplicates: "boolean", add_row_duplicate_flag: "boolean",
    },
    gotchas: ["With row_selection LAST after running-total snippets, it's the GroupBy workaround."],
  },
  {
    alias: "column-renamer", name: "Column Renamer", category: "Manipulation", verified: false, tags: ["rename"],
    factory: "org.knime.base.node.preproc.column.renamer.ColumnRenamerNodeFactory",
    in: [T(1, "table")], out: [T(1, "table")], keys: {},
    gotchas: ["Effectively unconfigurable: renamings is a list the API can't grow. Copy columns with a Java Snippet instead."],
  },
  {
    alias: "groupby", name: "GroupBy", category: "Manipulation", verified: false, tags: ["aggregate", "group", "sum", "mean"],
    factory: "org.knime.base.node.preproc.groupby.GroupByNodeFactory",
    in: [T(1, "table")], out: [T(1, "aggregated table")], keys: {},
    gotchas: ["Factory class not verified on this install.", "Blocked for now: its aggregation settings are a DataType array the API can't build. Use running-total snippets + dedupe, or a Group Loop."],
  },
  {
    alias: "table-creator", name: "Table Creator", category: "IO", verified: true, tags: ["manual", "data", "source"],
    factory: "org.knime.base.node.io.tablecreator.TableCreator2NodeFactory",
    in: [], out: [T(1, "table")], keys: {}, deprecated: "still addable; the modern Table Creator has a different factory",
    gotchas: [],
  },
  {
    alias: "wait", name: "Wait...", category: "Flow control", verified: true, tags: ["sleep", "delay"],
    factory: "org.knime.base.node.flowcontrol.sleep.SleepNodeFactory",
    in: [M(1, "flow variables (optional)", "flow")], out: [M(1, "flow variables", "flow")],
    keys: { wait_option: "0 = for a duration", for_seconds: "int", for_minutes: "int", for_milliseconds: "int" },
    gotchas: [],
  },
];

export function byAlias(alias: string): CatalogueEntry | undefined {
  const a = alias.toLowerCase();
  return CATALOGUE.find((e) => e.alias === a);
}

export function byFactory(factory: string): CatalogueEntry | undefined {
  return CATALOGUE.find((e) => e.factory === factory);
}

/** True if the text looks like a factory class name rather than an alias. */
export function isFactoryName(text: string): boolean {
  return /^[a-z][\w$]*(\.[\w$]+)+$/i.test(text) && text.includes(".");
}

/** Ranked by where the words match: alias, then name, then tags, category and factory. */
export function search(text: string): CatalogueEntry[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = CATALOGUE.map((e) => {
    let score = 0;
    for (const w of words) {
      const s = e.alias.includes(w) ? 8 : e.name.toLowerCase().includes(w) ? 4
        : (e.tags ?? []).some((t) => t.includes(w)) ? 3 : e.category.toLowerCase().includes(w) ? 2
        : e.factory.toLowerCase().includes(w) ? 1 : 0;
      if (s === 0) return { e, score: 0 };
      score += s;
    }
    return { e, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.e);
}
