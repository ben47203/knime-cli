<div align="center">

# knime-cli

**Drive a running KNIME Analytics Platform from your terminal, your scripts and your AI agents.**

Read workflows, add and wire nodes, patch settings, run pipelines and pull results out, all live in the KNIME window you already have open.

[![CI](https://github.com/ben47203/knime-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ben47203/knime-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/knime-cli/beta?label=npm&color=cb3837)](https://www.npmjs.com/package/knime-cli)
![KNIME 5.12](https://img.shields.io/badge/KNIME-5.12-fdd800)
![Status: beta](https://img.shields.io/badge/status-beta-orange)

[Install](#install) · [Quick start](#quick-start) · [Pipelines as code](#pipelines-as-code) · [Commands](#commands) · [How it works](#how-it-works) · [Safety](#safety)

</div>

---

```console
$ knime status
KNIME 5.12.0, pid 5915, ready
API v2 at http://127.0.0.1:61378
project churn: saved — ~/knime-workspace/churn

$ knime node add csv-reader --label my:reader
$ knime node set my:reader source.path.path=/data/customers.csv
$ knime run my:reader
$ knime node table my:reader --limit 3
```

The node appears on your canvas as you type. Everything you do through the CLI is a normal KNIME edit: you can see it, undo the structural changes, and keep working by hand alongside it.

## Why

KNIME is great for building data workflows visually, but it has no way to be *driven* from outside. knime-cli adds one:

- **For agents.** Every command takes `--json`, never prompts, and fails with a stable exit code, a cause and a next step. `knime guide` teaches an agent with no KNIME background what it needs to know.
- **For repeatable work.** Describe a pipeline in JSON and `knime apply` builds it, idempotently, by label. Re-run it and only what changed is touched.
- **For people.** Script the boring parts (wiring 40 nodes, filling column lists, exporting every chart) and keep the visual editor for the rest.

## Install

You need two pieces: the **KNIME extension**, which opens a local API inside KNIME, and the **CLI**, which talks to it.

### 1. The KNIME extension

> Requires **KNIME Analytics Platform 5.12** exactly. The extension uses KNIME internals, so each KNIME release needs a matching build.

1. In KNIME, open **Preferences → Install/Update → Available Software Sites** and click **Add**.
2. Name it `knime-cli`, with location:
   ```
   https://ben47203.github.io/knime-cli/update/
   ```
3. Open **File → Install KNIME Extensions…**, search for **KNIME CLI**, install it, and restart KNIME.

Offline or behind a proxy? Download the zipped update site from [Releases](https://github.com/ben47203/knime-cli/releases), then add it with **Add → Archive…** instead.

### 2. The CLI

Needs [Node.js](https://nodejs.org) 22 or newer.

```sh
npm install -g knime-cli@beta
knime status
```

If `knime status` reports `ready`, you're set.

## Quick start

A safe first session, read-only until the last step:

```sh
knime guide                    # short topics on KNIME and this API; start here
knime workflow show            # nodes, states, connections and unsaved changes
knime node settings <node>     # a node's settings as dot-paths
knime node ports <node>        # its ports, with column names and types
knime nodes search scorer      # the built-in catalogue of known-good nodes
knime apply pipeline.json --dry-run
```

Nodes are addressed by id (`root:7`, or just `7`) or by **label**. Ids are reused after deletes, so label the nodes you create and refer to them by label.

## Pipelines as code

A spec names nodes by key, wires them, and sets only the settings you care about:

```json
{
  "prefix": "hs:",
  "nodes": [
    { "key": "reader",    "alias": "csv-reader",
      "settings": { "source.path.path": "${HOUSING_CSV}" } },
    { "key": "partition", "alias": "partition", "note": "80/20 split, seed 42",
      "settings": { "percentage": 80, "mode": "RANDOM", "seed": 42, "seed_is_present": true } },
    { "key": "learn",     "alias": "linreg-learn",
      "settings": { "target": "median_house_value" } }
  ],
  "connections": [
    { "from": "reader:1",    "to": "partition:1" },
    { "from": "partition:1", "to": "learn:1" }
  ],
  "annotations": [{ "key": "prep", "text": "Data prep", "colour": "Meadow", "around": ["reader", "partition"] }]
}
```

```sh
knime apply housing.json --dry-run   # what would change
knime apply housing.json             # add, connect, run upstream, patch settings, run
knime save                           # the CLI never saves on its own
```

`apply` runs things in the order KNIME needs: many nodes only show their settings once their inputs have a table spec, so upstream nodes run before downstream ones are configured. Only nodes labelled with the spec's prefix are reused or removed, so nothing else on the canvas is touched. A full example lives in [`ts/cli/examples/housing-small.json`](https://github.com/ben47203/knime-cli/blob/main/ts/cli/examples/housing-small.json), and `knime guide apply` covers the details, including `$columns` selectors that fill column lists from upstream specs.

## Commands

| | Command | What it does |
|---|---|---|
| **Read** | `knime status` | Which KNIME, whether it's ready, API version, unsaved changes |
| | `knime workflow show` | Nodes, states, messages, connections |
| | `knime workflow svg` | The canvas as SVG, or PNG with `--png` |
| | `knime node settings <node>` | Settings as dot-paths (secrets redacted) |
| | `knime node ports <node>` | Ports with column names, types and domains |
| | `knime node table <node>[:port]` | Rows of an output table, as JSON or CSV |
| | `knime node image <node>` | Save a chart's PNG/SVG; `--enable` turns it on |
| | `knime annotate list` | Canvas annotations with tags, colours and bounds |
| **Write** | `knime node add / connect / label / note / set / rm` | Build and edit the workflow |
| | `knime annotate add / update / move / rm` | Draw and edit coloured annotation boxes |
| | `knime save` | Save the project in place, as KNIME's Save does |
| **Run** | `knime run [nodes…]` | Execute and wait, then fail if anything didn't run |
| | `knime apply <spec.json>` | Build and run a declarative pipeline |
| **Help** | `knime guide [topic]` · `knime nodes search/info` | Built-in docs and node catalogue |

Global options: `--json`, `--pid`, `--project`, `--workflow`. Run `knime <command> --help` for details.

<details>
<summary><b>Exit codes</b></summary>

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Unexpected error |
| 2 | Usage error |
| 3 | Not found |
| 4 | KNIME unavailable |
| 5 | Gateway stalled or timed out |
| 6 | Busy (a node is executing) |
| 7 | Rejected by KNIME |
| 8 | Nodes didn't execute |
| 9 | Refused by a safety rule |

With `--json`, errors are printed to stdout as `{"ok": false, "error": {"code", "message", "cause", "hint"}}`.

</details>

## How it works

```
 knime CLI / your agent ──HTTP + bearer token──▶  knime-cli extension (inside KNIME, 127.0.0.1 only)
                                                    ├─ /rpc → KNIME's own UI gateway: add, connect, delete, undo, run
                                                    └─ /api → workflow reads, settings, tables, images, save
```

- At start-up the extension opens a local HTTP server on a random port, and writes `~/.knime-cli/instances/<pid>.json` (mode 0600, deleted on exit) with the URL and a fresh token. The CLI finds it there.
- Structural edits go through the same gateway commands as KNIME's editor, so they show up live and can be undone. Settings changes use the same path as a dialog's **Apply**.
- Several KNIMEs running at once? The newest live one is used; pick another with `--pid`.

## Safety

- **Local only.** The server binds to `127.0.0.1`, needs the token from the 0600 discovery file, and rejects browser requests (`Origin` headers and foreign `Host` values).
- **Allowlist, not pass-through.** Only gateway methods that are checked to be side-effect-free for the UI are reachable.
- **Secrets stay in KNIME.** Passwords and credentials typed into nodes are redacted on read and refused on write.
- **Nothing is saved behind your back.** Every write warns when it leaves unsaved changes; only `knime save` saves.
- **Settings changes can't be undone** (as in KNIME's dialogs), and they reset the node and everything downstream. Use `--dry-run` first, and save before big changes.

## Limitations

This is an early beta.

- **KNIME 5.12 only.** It relies on internal, unpublished APIs, so new KNIME versions need a new build.
- **Desktop only.** It needs the KNIME UI running; there's no headless or batch mode.
- **Close a node's dialog** before changing its settings from the CLI. An open dialog shows stale values and would overwrite the change on Apply.

## Development

```
plugins/com.ben47203.knimecli.server   the KNIME extension (Java 21, OSGi bundle)
ts/src                                 typed client and instance discovery
ts/cli                                 the knime command, guide (CONTEXT.md) and catalogue
```

```sh
cd ts
npm install
npm run test:cli      # unit tests against an in-memory KNIME, no install needed
npm test              # integration tests against a running KNIME with the extension
npm run knime -- status
```

The extension is developed with Eclipse PDE against the KNIME 5.12 target platform (see [KNIME's SDK setup](https://github.com/knime/knime-sdk-setup)). Plans and design notes are in [ROADMAP.md](https://github.com/ben47203/knime-cli/blob/main/ROADMAP.md).

Issues and pull requests are welcome. Please open an issue before larger changes.

## Licence

To be confirmed before the first stable release.

<sub>knime-cli is an independent project and isn't affiliated with or endorsed by KNIME AG. KNIME® is a registered trademark of KNIME AG.</sub>
