# knime-cli Roadmap

A KNIME 5.12 plugin that exposes the running Analytics Platform over a local API, for a TypeScript CLI / MCP tool.

## Architecture

```
TS CLI / MCP  ──HTTP + token──▶  Java plugin (Jetty, 127.0.0.1)
                                   ├─ /rpc  → gateway DefaultJsonRpcRequestHandler (same API as KNIME's UI)
                                   └─ /api  → our endpoints on WorkflowManager (settings, tables, summaries)
```

- **Gateway** (`org.knime.gateway.*`): workflow reads, commands (add/connect/delete nodes, undo), execute/reset, node search. Changes show up live in the UI.
- **WorkflowManager** (`org.knime.core`): anything the gateway does badly. Mainly node settings (`saveNodeSettings` / `loadNodeSettings`, works for every node) and paged table data.
- Not a public API. Pinned to KNIME 5.12; re-test on every KNIME upgrade.
- UI mode only (no headless).

## Milestones

### M0: Environment ✅
Temurin 21, Eclipse 2025-06 RCP, `knime-sdk-setup` (branch `releases/2026-06`, `KNIME-AP.target` → 5.12 site), test launch working.

### M1: Spike (prove the approach)
- Plugin project, started at launch (`org.eclipse.ui.startup`)
- Jetty on `127.0.0.1:<random>`, bearer token, discovery file `~/.knime-cli/instances/<pid>.json` (0600, deleted on exit)
- `/rpc` pass-through to `DefaultJsonRpcRequestHandler`
- TS script: `ApplicationService.getState` → `getWorkflow` → `AddNodeCommand`, node appears in the UI
- Check: threading, errors, Host/Origin rejection

### M2: Core API
- `/api` endpoints: open/save workflow, get/set node settings (JSON ⇄ `NodeSettings`), paged port tables + specs, node messages, flow variables
- Change detection by polling snapshot IDs
- API version + KNIME version in `status`

### M3: TS client + CLI
- Typed client (types from the `knime-ui` repo / gateway entities)
- Instance discovery, auth, CLI commands for the M2 surface

### M4: MCP server
- Tools built on the TS client
- LLM-friendly context: workflow outline, node descriptions as text, capped previews
- Read-only by default; writes need explicit opt-in

### M5: Packaging
- Tycho build → feature → p2 update site
- Test fragment with small test workflows
- Install via *File → Install KNIME Extensions*

## Later / open questions
- Push events (hooking the gateway event consumer) instead of polling
- Check whether KNIME ships an official MCP / automation API first
- Agent edits share the user's undo history: how to show this in the UI
