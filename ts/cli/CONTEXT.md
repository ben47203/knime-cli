# What a knime-cli consumer needs to know

The consumer has no knowledge of KNIME internals or this codebase. It might be a person in a terminal or an LLM agent. Everything below cost us real debugging time in two dogfooding runs: a penguins analysis, and a California housing ML pipeline with 55 nodes. The CLI's job is to make this knowledge available at the moment it matters, through help text, `guide` topics, recipes, error hints and command defaults. It shouldn't rely on the consumer reading the server's code.

This file is the source of `knime guide`. Each `## … {#topic}` section is one topic; keep them short, and keep the topic ids stable (agents may ask for them by name).

## Quick start {#start}
A safe first session, read-only until the last steps:
1. `knime status` — is KNIME running and ready? Which instance (pid) and API version?
2. `knime workflow show` — the open project, its nodes (id, label, name, state, message) and connections.
3. `knime node settings <node>` — a node's settings as dot-paths. `<node>` is an id (`root:7`, or just `7`) or a label. `knime node ports <node>` shows its ports and the columns on them.
4. `knime nodes search <text>` / `knime nodes info <alias>` — the built-in catalogue of known-good nodes, their settings keys, presets and gotchas (ports come from KNIME: `knime node ports`).
5. `knime apply pipeline.json --dry-run` — what a declarative pipeline would add, connect and remove. Drop `--dry-run` to build and run it.

Every command takes `--json` (machine-readable output, errors included) and shows its tier in `--help`: READ changes nothing, WRITE changes the workflow, EXEC runs nodes. The CLI never prompts and never saves the project on its own; see [Saving](#saving).

## Saving {#saving}
- Changes made through the CLI live only in KNIME's memory until the project is saved. The CLI **never saves on its own**: run `knime save` when the work should be kept.
- **After every WRITE or EXEC command** the CLI reads the project's unsaved-changes flag. If it's set, it warns `project "…" has unsaved changes; \`knime save\` saves them`; with `--json` the warning is in `warnings` and the envelope has `"dirty": true`. This happens even when the command failed part-way, since it may have changed things first.
- **Before a command that resets nodes** (`node set` with a real change, `apply`), it also warns if the project *already* had unsaved changes: settings changes can't be undone, so the last save is the only way back. Save first if you want a restorable state.
- `knime save` saves the project (`--project`, or the default one) to its own folder, exactly as KNIME's Save does, including the preview image. It reports the path, and does nothing if there's nothing unsaved. It's refused with **SAVE_BLOCKED** (exit 7) for component projects, temporary copies of Hub, Server or archive workflows, read-only projects, or a locked folder; there's no "save as".
- `knime workflow show` (and `knime status`) report `dirty`, `canSave`, `saveBlocked` and `path` under `project`.

## Connecting {#connecting}
- **Discovery:** each running KNIME with the plugin writes `~/.knime-cli/instances/<pid>.json` with `url`, `token`, `pid`, `apiVersion` and `startedAt`.
  - Stale files from dead processes are common. The CLI checks that the pid is alive and prefers the newest live instance.
  - `--pid` and `KNIME_CLI_PID` override the choice.
- **Readiness:** `/status` gives `ready: false` until KNIME's UI has initialised. Until then every other call returns 503 with `Retry-After`, so wait and retry (`knime status --wait 60`).
- **Requests:** every request needs a bearer token, `Host` set to 127.0.0.1 or localhost, and no `Origin` header. Browsers are blocked on purpose.
- **Version:** `apiVersion`, currently 2. The CLI warns if it differs from what it was built for.
- **Which KNIME:** the running KNIME may be the Eclipse PDE dev launch, not `/Applications/KNIME*.app`. The available nodes depend on that launch's bundle list, so don't assume a node exists because the .app has it.

## The mental model {#model}
- **Project → workflow → node.** `projectId` comes from the open projects (`--project`, by id or name). `workflowId` is `root`, or a metanode or component id, to reach nodes inside it (`--workflow`).
- **Node ids** look like `root:7` or `root:5:0:3`.
  - **Ids are reused after a delete**, so never cache ids across runs. Identify your own nodes by **label** (`knime node label root:7 cal:rf-learn`), and scope any cleanup to your labels only. Never "delete everything".
- **Ports:** port **0** is the hidden flow-variable port, so data ports start at **1**. Learners often output the model on a higher port. For example, the random forest learner's model is on port 3. A wrong port gives only "Connection could not be created".
  - `knime node ports <node>` lists a placed node's ports from KNIME: names, types, what they're connected to, and each table's column names and types (with domains), or the reason a spec is missing ("not connected", "no spec until the node executes", "upstream not configured"). `knime workflow show --ports` gives a one-line summary per port for every node.
- **Node states:** IDLE (not configurable yet), CONFIGURED, QUEUED, EXECUTING, EXECUTED, plus a warning or error message.
- **Build progressively, in this order:** add → connect → **execute upstream** → read settings → patch settings → execute.
  - A node shows **empty settings** (`model: {}`) until its input has a table spec, and CSV Reader only provides a spec once it has run.
  - Learners and predictors (the tree predictors in particular) show `{}` until they are **connected**; after connecting, their options appear.
  - So you can't configure a whole pipeline before running any of it. `knime apply` does this ordering for you.
- **Factory ids** are long Java class names, e.g. `org.knime.base.node.preproc.filter.column.DataColumnSpecFilterNodeFactory`. The catalogue gives them friendly aliases (`column-filter`) and flags deprecated nodes.

## Settings {#settings}
- `knime node settings <node>` returns `model` (the node's settings), `variables` (flow-variable bindings, read-only) and `redacted` (JSON Pointers of secrets replaced by `{"$redacted": true}`). By default it prints `model` as dot-paths: `a.b.c = value`. Keys containing `.`, `[`, `]`, `"`, `=` or `:` are quoted: `dataTypeSettings["org.knime.core.data.def.DoubleCell"].factoryID`.
- `knime node set <node> path=value …` is a **partial patch**. Plain values (JSON: `80`, `true`, `["a","b"]`, else text) change **existing** keys and are coerced to the entry's type; the whole patch is all-or-nothing. A unique suffix is enough (`source.path.path=/x.csv`); the CLI says what it expanded it to.
- **Typed values create keys or change a key's type:** `{"$type": "<type>", "value": …}` in a patch file or spec, or `path:<type>=value` on the command line.
  - Leaf types: string (value may be null), int, long, short, byte, double, float, boolean, char. Coercion is strict: `1.0` isn't an int.
  - Arrays: any leaf type plus `[]` (`string[]`, `boolean[]`), and `config[]` (an array of objects). Elements are plain values.
  - `config`: a JSON object whose fields may be typed or plain; plain fields are inferred (string/null → string, boolean, integral → int, other number → double, object → config, a non-empty array of one kind → that type with `[]`). An empty or mixed array needs an explicit `$type`.
  - Lists and groups grow one typed entry at a time: Column Renamer `renamings` takes `{"0": {"$type": "config", "value": {"oldName": "a", "newName": "b"}}, "1": …}`.
  - An empty array on a fresh node reads back as a string array; give `boolean[]`, `config[]` etc. explicitly (GroupBy's `inclMissingVals`, `columnTypes`).
  - Refused: secret-looking key names, `*_Internals` keys, anything inside credentials configs, and password types.
  - On the command line, `path:json=…` only parses the value and never wraps it.
- `set` **resets the node and everything downstream**, just like a dialog's Apply. It **can't be undone**. A dialog that's open in the UI keeps showing stale values, and applying it overwrites the change. A patch that matches the current settings is a no-op (`changed: false`) and keeps results. Use `--dry-run` to see the diff first.
- **Secrets** (passwords, credentials, tokens typed into a node) are never returned and can't be set.
- **Null values** appear as JSON `null` (e.g. Java Snippet `expression` on a fresh node, a predictor's `custom_prediction_name`).
- **Incomplete reads:** if a node's own save throws, `get` still answers 200 but with `complete: false` and a `problem` naming the exception and the last key written. The fresh tree learners (random forest, gradient boosting, regression tree) do this because their split criterion is null: their read stops after `nrModels`, and the missing keys must be created with typed values **in one set**. `knime nodes info rf-learn` shows the full patch as a preset; after that the settings are complete and plain patches work.
- **Gotchas found by experience:**
  - **No discovery of valid values:** Missing Value handler ids are factory class names (`…handlers.MedianNumberMissingCellHandlerFactory`); GroupBy methods are ids like `Count` and `Mean_V4.6`.
  - **Misleading key names:** Java Snippet (simple) `append_column: true` actually means *replace*, so set it to false to append. Its expression needs a full statement, `return …;`, or it fails with a cryptic `"~"` error. GroupBy's key is spelt `grouByColumns`.
  - **Silent no-ops:** a Column Renamer entry with a wrong `oldName` passes the column through unrenamed, with no error or warning. Check the output column names downstream.
  - **Generated names:** GroupBy names its outputs `<Method>(<column>)`, but Count's is `Count*(<column>)` (with an asterisk: it counts rows, missing values included); Mean's is `Mean(<column>)`.
  - **Accepted but fails later:** GBT `alphaFraction: 1.0` passes the set, then execute fails with `Index N out of bounds for length N` (N = training rows). Keep it below 1 (default 0.95).
  - **Guessed defaults are often wrong:** learners guess a target column, Partitioning defaults to 70% with a random seed, and the tree learners pick the last numeric column. Always set target, seed and fraction explicitly.
  - **Gradient boosting is sensitive to its settings** (California housing, 80/20 split): depth 4 at learning rate 0.1 and full data gave R² 0.812 at 100 trees, 0.842 at 500 and 0.847 at 1000; depth 6–8 or `dataFraction` 0.8 dropped it to about 0.79–0.80, and `minNodeSize`/`minChildSize` 20/10 to 0.801. Random forest: `Linear` column sampling at 0.33 per node (0.832) beat 0.5 slightly; 500 trees were no better than 300 but 3× slower. RProp MLP 2×32 neurons: 0.795 at 1000 iterations (about 90 s).

## Execution {#execution}
- `knime run [nodes…]` executes the nodes (and whatever they need upstream), or the whole workflow, and waits. The server's `execute` waits at most 30 s, so the CLI loops on `wait` until `--timeout`.
- **The server can report `done: true, failed: []` while target nodes stayed IDLE** because they were never configured. `knime run` always checks the final states and fails (exit 8) listing the nodes that didn't run, with their messages.
- `/rpc` workflow commands (add, connect, label, delete) normally answer in about 100 ms.
  - **504** means KNIME didn't confirm within 30 s. The command was *probably applied*, so re-read the workflow before retrying.
  - **503 "N earlier calls … unanswered"** means KNIME has stopped confirming commands. Stop, and ask the user to reopen the workflow or restart KNIME.
- Long executes are fine: only gateway commands have the 30 s limit, and `run` keeps waiting (a 253 s MLP run never hit a 504).
- **Tune cheaply:** changing a node's settings resets only its downstream branch, so re-running just the final node (e.g. the metrics writer) re-executes only what changed: 10–25 s per trial instead of a full rebuild.

## Reading tables {#tables}
- `knime node table <node>[:port]` returns the rows of the table on an output port. The port defaults to 1, the first data port (0 is the flow-variable port): `my:predict`, `my:partition:2`, `root:12:1`. A metanode has no flow-variable port, so its ports (and the default) start at 0. For a node inside a metanode or component, pass `--workflow <its id>`.
- **Read-only, so execute first:** it reads the table the node already holds and never runs or configures anything. A node that hasn't executed fails with **NODE_NOT_EXECUTED** (exit 8; the message and `details.state` give its state) rather than returning an empty table. Run it with `knime run <node>`, then read.
- **Output:** JSON by default, the plugin's page: `{nodeId, port, totalRows, offset, returned, columns: [{name, type}], rows: [{rowId, cells}]}`. Without `--json` it's printed one row per line; with `--json` it's the envelope's `data`. Column types are KNIME's names (`String`, `Number (Float)`, `Number (Integer)`), as in `node ports`.
- **Cells:** numbers are JSON numbers at full double precision (they read back to the same double), integers as integers, booleans as booleans, missing values `null`, NaN and ±Infinity as the strings `"NaN"`, `"Infinity"`, `"-Infinity"`. Everything else (text, dates, collections) is its text.
- **Paging:** `--limit` (default 1000; `0` gives just the columns and `totalRows`) and `--offset` (from 0). An offset past the end gives no rows and the right `totalRows`. `--limit all` reads the whole table; the CLI fetches it in pages of up to 50,000 rows (fewer for wide tables) and joins them.
- **Columns:** `--columns 'Churned,P (Churned=1)_gbt1'` picks columns by exact name, in that order; CSV-quote a name with a comma. An unknown name fails with **COLUMN_NOT_FOUND**, listing the available columns.
- **CSV:** `--csv` writes a header row with `RowID` first, RFC 4180 quoting, numbers at full precision, missing values as empty fields, and LF line ends. `-o file` writes JSON or CSV to a file and reports the path and row count (on stderr, or as `file` in the `--json` envelope, without the rows). `--csv --json` needs `-o`.
- **Errors:** **PORT_OUT_OF_RANGE** (exit 7: the message lists the node's output ports by index, name and type), **NOT_A_TABLE** (exit 7: a model, image or flow-variable port), **TABLE_INACTIVE** (exit 8: an inactive branch), **TABLE_CHANGED** (exit 6: the node was reset or re-run during the read; read again).
- Example, an ML check: `knime run my:predict && knime node table my:predict --limit all --columns 'Churned,Prediction (Churned)' --csv -o preds.csv`.

## Errors {#errors}
Errors come back with a stable exit code, a cause and a next step; with `--json` they're printed to stdout as `{"ok": false, "error": {"code", "message", "cause", "hint"}}`. The table below is generated from the CLI's error translations.

## Data in and out {#data}
- Read an executed node's output table straight from KNIME with `knime node table <node>[:port]`, as JSON or CSV (see the tables topic). A CSV Writer is only needed for files KNIME itself should keep. Column names and types without executing: `knime node ports <node>`.
- Charts come out as files: `knime node image <chart> --enable -o chart.png` (see the images topic).
- Paths in settings are local filesystem paths on the KNIME host.

## Pictures of the workflow and its charts {#images}
- `knime workflow svg -o canvas.svg` saves the canvas as KNIME draws it for the saved workflow preview: nodes, names, states, ports, connections and annotations, cropped to the nodes. Without `-o` the SVG goes to stdout. `--workflow <id>` draws a metanode or component's inside.
- `knime workflow svg --png -o canvas.png [--scale 2]` renders it to PNG. The SVG's text is HTML inside `foreignObject`, which only a browser renders faithfully, so this shells out to a headless Chrome, Chromium or Edge, a browser Playwright downloaded, or the `playwright` CLI (`KNIME_CLI_BROWSER` overrides). With none, it fails with NO_BROWSER; the SVG itself needs no browser.
- **Charts as images, from any chart node, in one command:** `knime node image <chart> --enable -o chart.png`.
  - KNIME's current chart nodes (Bar Chart, Line Plot, Scatter Plot, …) share a `generateImage` setting (with `imageFormat` PNG or SVG, `width`, `height`; default 800 × 600) and an extendable **Output Image** port group. The image port exists only when the group has a port, which the dialog's Apply adds but `node set` doesn't.
  - `--enable` does all of it: it finds `generateImage` in the node's settings (so it works for any chart node that has it, not a fixed list), adds the Output Image port with the gateway's `add_port` command if there isn't one, sets `generateImage: true` plus `--format PNG|SVG`, `--width`, `--height` (`-o x.svg` alone also picks SVG), runs the node, and writes the image. Re-running it adds nothing twice.
  - Without `--enable` it only reads: the first image output port (or `--port N`) of an executed node. The extension follows the content type, and the default file name is the node's label.
  - The chart itself still needs its columns: e.g. Bar Chart `categoryColumnV3=city aggregationMethod=SUM frequencyColumnsV2.mode=MANUAL frequencyColumnsV2.manualFilter.manuallySelected='["sales"]'` (`knime nodes info bar-chart`).
  - Errors: NO_IMAGE_PORT (exit 3: no image port; the hint says whether `--enable` would help), IMAGE_NOT_READY (exit 8: not executed yet), NO_IMAGE_SETTING (exit 7: not a chart node).
- If the plugin can't reach KNIME's renderer in this KNIME version, `/status` says `capabilities.workflowSvg: false` and the command fails with CAPABILITY_MISSING (exit 4).

## Recipes that are known to work {#recipes}
Settings keys verified in the dogfooding runs. `knime nodes info <alias>` has the keys for each; `knime node ports <node>` gives a placed node's ports.
- **CSV Reader** (`csv-reader`): `…multiFileSelectionParams.source.path.path`. Empty fields count as missing; text `NA` does not, and there's no setting for a missing-value pattern.
- **CSV Writer** (`csv-writer`): `path`, `if_path_exists`, `create_missing_folders`, `write_row_header`.
- **Missing Value** (`missing-value`): set `dataTypeSettings.<DoubleCell|IntCell>.factoryID`.
- **Column Filter** (`column-filter`): `included_names`, `excluded_names`, `enforce_option`.
- **One to Many** (`one-to-many`): `included_names`.
- **Partitioning** (`partition`): `percentage`, `seed`.
- **Linear and polynomial regression** (`linreg-learn`, `polyreg-learn`), predicted with `reg-predict`.
- **RProp MLP** (`rprop-learn`, predicted with `mlp-predict`): needs the target scaled to [0,1] with a Normalizer (min-max) and has no column filter, so filter the columns upstream.
- **Tree learners** (`rf-learn`, `gbt-learn`, `rtree-learn`): wire first, then set the whole preset in one go (`knime nodes info rf-learn`); their models are on port 3 (random forest) and port 1 (the others). Predict with their own predictors (`rf-predict`, `gbt-predict`, `rtree-predict`); the PMML predictor rejects these models.
- **Column Appender** (`column-appender`): use `add_port` for more than 2 inputs.
- **Numeric Scorer** (`numeric-scorer`): gives R², RMSE and MAE.
- **GroupBy** (`groupby`): `grouByColumns.InclList`, plus parallel arrays in `aggregationColumn` (`columnNames`, typed `columnTypes`, `aggregationMethod`, typed `inclMissingVals`); see the `aggregate` preset.
- **Column Renamer** (`column-renamer`): typed `renamings` entries; see the `rename` preset, and check `oldName` exactly.
- **Bar Chart** (`bar-chart`): `categoryColumnV3`, `aggregationMethod`, `frequencyColumnsV2.manualFilter.manuallySelected`; get the chart as a PNG or SVG with `knime node image <node> --enable` (see `knime guide images`).

## Declarative pipelines {#apply}
`knime apply pipeline.json` builds a pipeline from a spec, idempotently, keyed by label:
```json
{
  "prefix": "hs:",
  "nodes": [
    { "key": "reader", "alias": "csv-reader", "settings": { "source.path.path": "/data/housing.csv" } },
    { "key": "missing", "alias": "missing-value" }
  ],
  "connections": [ { "from": "reader:1", "to": "missing:1" } ],
  "run": ["missing"]
}
```
- Every node gets the label `<prefix><key>`. On a re-run, a node with that label and the same factory is reused; nodes with the prefix that the spec no longer has (or whose factory changed) are removed. Nothing without the prefix is touched.
- Settings keys may be nested objects or dot-paths (suffixes allowed, as in `node set`), and values may be typed (`{"$type": …}`). String values expand `${VAR}` and `${VAR:-default}` from the environment; defaults may nest, and HOME is always set, so `${DATA:-${HOME}/data.csv}` defaults to a file in the home folder.
- `"preset": {"name": "regression", "target": "y", "exclude": ["id"]}` (or just `"preset": "regression"`) starts from a catalogue preset, built from its parameters; `settings` then override single keys, keeping the preset's `$type` where it has one. `knime nodes info <alias>` lists a node's presets and parameters.
- **Column selectors:** where a setting takes a list of column names, `{"$columns": {…}}` stands for the names picked from an upstream node's output **when apply reaches the node**, so the spec needn't spell out every column:
  ```json
  "column_filter": { "included_names": { "$columns": { "from": "missing:1", "type": "number", "exclude": ["median_house_value"] } } }
  ```
  - `from`: `key[:port]` of a spec node's output (port 1 by default). Leave it out to read whatever feeds this node's input 1. That node is run first, so its spec exists.
  - `type`: a group (`number`, `integer`, `decimal`, `string`, `boolean`, `datetime`) or text in KNIME's type name (`Number (Float)`); a string or an array of them.
  - `include` (only these, in this order), `exclude` (drop these), `pattern` (regular expression on the name). With none, every column.
  - The result is a plain string array, so it replaces existing list keys; wrap it to create a key: `{"$type": "string[]", "value": {"$columns": …}}`. Names in `include`/`exclude` that aren't in the input, and selectors that pick nothing, are warnings (a typo would otherwise pass silently). A source port without a table spec fails with NO_COLUMNS.
  - `knime node ports <node>` shows the columns a selector would choose from.
- Order: nodes are visited upstream first; each node's direct inputs are executed before its settings are patched, so the settings exist. Then `run` (default: every node without outgoing connections in the spec) is executed and checked like `knime run`.
- Port numbers in `connections` aren't checked offline: KNIME checks them when connecting, and a refusal names the ports both nodes really have.
- `--dry-run` shows the structural plan (adds, reuses, removals, connections) without touching KNIME. `--rebuild` removes and re-adds every prefixed node.

## What this means for the CLI's design {#design}
1. **A `guide` command** with short topics (model, settings, execution, errors, recipes), so a consumer with no context can bootstrap. Agents read `--help` and `guide` before acting.
2. **Friendly addressing:** look nodes up by label as well as id, and factories by alias (`csv-reader`, `rf-learn`) from a built-in catalogue that records known settings keys; ports come live from KNIME (`node ports`).
3. **Dot-path settings:** `knime node set reader source.path.path=/x.csv`, with JSON and type hints, plus a `--dry-run` that shows the diff and warns that downstream nodes will be reset.
4. **A declarative pipeline:** `knime apply pipeline.json` that is idempotent, keyed by label, and builds progressively (executing upstream before configuring downstream).
5. **Honest execution:** `run` waits for completion, loops past the 30 s cap, and fails with a list of nodes that didn't run.
6. **Error translation:** map known server errors to a cause and a next step (504/503, "unknown setting", "Connection could not be created", empty model, and so on).
7. **Agent-friendly output:** `--json` on every command, stable exit codes, no prompts, and non-zero exits with machine-readable errors.
8. **Safety:** commands show their tier (READ/WRITE/EXEC), destructive operations only touch labelled nodes by default, and the CLI never saves the project unless asked (`knime save`), but says when there are unsaved changes.
