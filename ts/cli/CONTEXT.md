# What a knime-cli consumer needs to know

The consumer has no knowledge of KNIME internals or this codebase. It might be a person in a terminal or an LLM agent. Everything below cost us real debugging time in two dogfooding runs: a penguins analysis, and a California housing ML pipeline with 55 nodes. The CLI's job is to make this knowledge available at the moment it matters, through help text, `guide` topics, recipes, error hints and command defaults. It shouldn't rely on the consumer reading the server's code.

This file is the source of `knime guide`. Each `## … {#topic}` section is one topic; keep them short, and keep the topic ids stable (agents may ask for them by name).

## Quick start {#start}
A safe first session, read-only until the last steps:
1. `knime status` — is KNIME running and ready? Which instance (pid) and API version?
2. `knime workflow show` — the open project, its nodes (id, label, name, state, message) and connections.
3. `knime node settings <node>` — a node's settings as dot-paths. `<node>` is an id (`root:7`, or just `7`) or a label.
4. `knime nodes search <text>` / `knime nodes info <alias>` — the built-in catalogue of known-good nodes, their ports and settings keys.
5. `knime apply pipeline.json --dry-run` — what a declarative pipeline would add, connect and remove. Drop `--dry-run` to build and run it.

Every command takes `--json` (machine-readable output, errors included) and shows its tier in `--help`: READ changes nothing, WRITE changes the workflow, EXEC runs nodes. The CLI never prompts and never saves the project.

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
- **Node states:** IDLE (not configurable yet), CONFIGURED, QUEUED, EXECUTING, EXECUTED, plus a warning or error message.
- **Build progressively, in this order:** add → connect → **execute upstream** → read settings → patch settings → execute.
  - A node shows **empty settings** (`model: {}`) until its input has a table spec, and CSV Reader only provides a spec once it has run.
  - So you can't configure a whole pipeline before running any of it. `knime apply` does this ordering for you.
- **Factory ids** are long Java class names, e.g. `org.knime.base.node.preproc.filter.column.DataColumnSpecFilterNodeFactory`. The catalogue gives them friendly aliases (`column-filter`) and flags deprecated nodes.

## Settings {#settings}
- `knime node settings <node>` returns `model` (the node's settings), `variables` (flow-variable bindings, read-only) and `redacted` (JSON Pointers of secrets replaced by `{"$redacted": true}`). By default it prints `model` as dot-paths: `a.b.c = value`. Keys containing `.`, `[`, `]`, `"`, `=` or `:` are quoted: `dataTypeSettings["org.knime.core.data.def.DoubleCell"].factoryID`.
- `knime node set <node> path=value …` is a **partial patch of existing keys**. Values are JSON (`80`, `true`, `["a","b"]`), falling back to a plain string. Values are coerced to the existing entry's type, and the whole patch is all-or-nothing. A unique suffix is enough (`source.path.path=/x.csv`); the CLI says what it expanded it to.
- Typed values: `path:int=3`, `path:string=80`, `path:json='{"a":1}'`. For a key that doesn't exist yet, a typed value is sent as `{"$type": "int", "value": 3}`, which a server update will use to create keys.
- `set` **resets the node and everything downstream**, just like a dialog's Apply. It **can't be undone**. A dialog that's open in the UI keeps showing stale values, and applying it overwrites the change. A patch that matches the current settings is a no-op (`changed: false`) and keeps results. Use `--dry-run` to see the diff first.
- **Secrets** (passwords, credentials, tokens typed into a node) are never returned and can't be set.
- **Gotchas found by experience.** These are server bugs being fixed; the CLI hints at them until they're gone:
  - **Hidden nulls:** keys whose value is null are missing from `get`, but `set` accepts them, e.g. Java Snippet `expression`, `header`, `replaced_column`, `return_type`, or a predictor's `custom_prediction_name`. The CLI sends a key it can't see, with a warning.
  - **Partial model:** if a node's own save throws, `get` returns a cut-off model. All regression tree learners do this, because their split criterion is null by default. Newer servers flag it with `complete: false`.
  - **Keys can't be added:** lists and groups can't grow (`renamings/1` gives "unknown setting"), and empty arrays only accept strings. GroupBy and Pivot are effectively unconfigurable for now.
  - **No discovery of valid values:** e.g. Missing Value handler ids are factory class names (`…handlers.MedianNumberMissingCellHandlerFactory`).
  - **Misleading key names:** Java Snippet (simple) `append_column: true` actually means *replace*, so set it to false to append. Its expression needs a full statement, `return …;`, or it fails with a cryptic `"~"` error.
  - **Guessed defaults are often wrong:** learners guess a target column, Partitioning defaults to 70% with a random seed, and the tree learners pick the last numeric column. Always set target, seed and fraction explicitly.

## Execution {#execution}
- `knime run [nodes…]` executes the nodes (and whatever they need upstream), or the whole workflow, and waits. The server's `execute` waits at most 30 s, so the CLI loops on `wait` until `--timeout`.
- **The server can report `done: true, failed: []` while target nodes stayed IDLE** because they were never configured. `knime run` always checks the final states and fails (exit 8) listing the nodes that didn't run, with their messages.
- `/rpc` workflow commands (add, connect, label, delete) normally answer in about 100 ms.
  - **504** means KNIME didn't confirm within 30 s. The command was *probably applied*, so re-read the workflow before retrying.
  - **503 "N earlier calls … unanswered"** means KNIME has stopped confirming commands. Stop, and ask the user to reopen the workflow or restart KNIME.

## Errors {#errors}
Errors come back with a stable exit code, a cause and a next step; with `--json` they're printed to stdout as `{"ok": false, "error": {"code", "message", "cause", "hint"}}`. The table below is generated from the CLI's error translations.

## Data in and out {#data}
- There's no table-preview endpoint yet. Port summaries are just "Rows: N, Cols: M", so results must be written to CSV with a CSV Writer and read from disk. Column names downstream can only be inferred.
- Paths in settings are local filesystem paths on the KNIME host.

## Recipes that are known to work {#recipes}
Settings keys verified in the dogfooding runs. `knime nodes info <alias>` has ports and keys for each.
- **CSV Reader** (`csv-reader`): `…multiFileSelectionParams.source.path.path`. Empty fields count as missing; text `NA` does not, and there's no setting for a missing-value pattern.
- **CSV Writer** (`csv-writer`): `path`, `if_path_exists`, `create_missing_folders`, `write_row_header`.
- **Missing Value** (`missing-value`): set `dataTypeSettings.<DoubleCell|IntCell>.factoryID`.
- **Column Filter** (`column-filter`): `included_names`, `excluded_names`, `enforce_option`.
- **One to Many** (`one-to-many`): `included_names`.
- **Partitioning** (`partition`): `percentage`, `seed`.
- **Linear and polynomial regression** (`linreg-learn`, `polyreg-learn`), predicted with `reg-predict`.
- **RProp MLP** (`rprop-learn`, predicted with `mlp-predict`): needs the target scaled to [0,1] with a Normalizer (min-max) and has no column filter, so filter the columns upstream.
- **Gradient Boosted Trees** (`gbt-learn`): use its own `gbt-predict`; the PMML predictor rejects its model.
- **Column Appender** (`column-appender`): use `add_port` for more than 2 inputs.
- **Numeric Scorer** (`numeric-scorer`): gives R², RMSE and MAE.
- **Group aggregates:** GroupBy is blocked for now. The workaround is a Group Loop (Group Loop Start → Statistics → Loop End) or running-total snippets.

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
- Settings keys may be nested objects or dot-paths (suffixes allowed, as in `node set`). String values expand `${VAR}` and `${VAR:-default}` from the environment.
- Order: nodes are visited upstream first; each node's direct inputs are executed before its settings are patched, so the settings exist. Then `run` (default: every node without outgoing connections in the spec) is executed and checked like `knime run`.
- `--dry-run` shows the structural plan (adds, reuses, removals, connections) without touching KNIME. `--rebuild` removes and re-adds every prefixed node.

## What this means for the CLI's design {#design}
1. **A `guide` command** with short topics (model, settings, execution, errors, recipes), so a consumer with no context can bootstrap. Agents read `--help` and `guide` before acting.
2. **Friendly addressing:** look nodes up by label as well as id, and factories by alias (`csv-reader`, `rf-learn`) from a built-in catalogue that records ports and known settings keys.
3. **Dot-path settings:** `knime node set reader source.path.path=/x.csv`, with JSON and type hints, plus a `--dry-run` that shows the diff and warns that downstream nodes will be reset.
4. **A declarative pipeline:** `knime apply pipeline.json` that is idempotent, keyed by label, and builds progressively (executing upstream before configuring downstream).
5. **Honest execution:** `run` waits for completion, loops past the 30 s cap, and fails with a list of nodes that didn't run.
6. **Error translation:** map known server errors to a cause and a next step (504/503, "unknown setting", "Connection could not be created", empty model, and so on).
7. **Agent-friendly output:** `--json` on every command, stable exit codes, no prompts, and non-zero exits with machine-readable errors.
8. **Safety:** commands show their tier (READ/WRITE/EXEC), destructive operations only touch labelled nodes by default, and the CLI never saves the project unless asked.
