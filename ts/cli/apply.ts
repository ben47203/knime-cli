/**
 * `knime apply`: a declarative pipeline, idempotent by label, built progressively (add → connect → run upstream →
 * patch → run). The planner is pure; the executor carries a plan out against a Session.
 */
import { byAlias, byFactory, isFactoryName, type CatalogueEntry } from "./catalogue.ts";
import { CliError, EXIT, usage } from "./errors.ts";
import { runNodes, type RunReport } from "./execute.ts";
import { formatChanges, planObject, type Change } from "./patch.ts";
import { isObject } from "./paths.ts";
import { buildPreset, overlay, type PresetRef } from "./presets.ts";
import type { NodeView, Session, Snapshot } from "./session.ts";
import type { Json, JsonObject, SetResult, Settings } from "./types.ts";

export interface SpecNode {
  key: string;
  alias?: string;
  factory?: string;
  settings?: JsonObject;
  /** A catalogue preset (`"regression"`, or `{"name": "regression", "target": …}`); `settings` override its keys. */
  preset?: PresetRef;
  /** Grid position [column, row]; defaults to the node's depth and its index at that depth. */
  at?: [number, number];
}

export interface SpecConnection {
  from: string;
  to: string;
}

export interface PipelineSpec {
  prefix: string;
  nodes: SpecNode[];
  connections?: SpecConnection[];
  /** Keys to execute at the end; default: every node without an outgoing connection. */
  run?: string[];
}

export interface Endpoint {
  key: string;
  port: number;
}

export interface ResolvedNode extends SpecNode {
  factory: string;
  label: string;
  entry?: CatalogueEntry;
  inputs: { from: Endpoint; toPort: number }[];
  depth: number;
}

export interface ResolvedSpec {
  prefix: string;
  /** Upstream first. */
  nodes: ResolvedNode[];
  connections: { from: Endpoint; to: Endpoint }[];
  run: string[];
}

const KEY = /^[A-Za-z0-9_.-]+$/;

/** `key[:port]`, port defaulting to 1 (the first data port; 0 is the flow-variable port). */
export function parseEndpoint(text: string): Endpoint {
  const m = /^([^:]+)(?::(\d+))?$/.exec(text);
  if (!m) throw usage(`Bad endpoint "${text}"; expected key or key:port`);
  return { key: m[1]!, port: m[2] === undefined ? 1 : Number(m[2]) };
}

/** Expands `${VAR}` and `${VAR:-default}` in every string of a settings object. */
export function expandEnv(value: Json, env: Record<string, string | undefined> = process.env): Json {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (def !== undefined) return def;
      throw usage(`Environment variable ${name} is not set (used in the spec); set it or write \${${name}:-default}`);
    });
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
  return value;
}

/** Validates a spec and puts its nodes in dependency order. Throws a USAGE error listing every problem found. */
export function resolveSpec(raw: unknown, env?: Record<string, string | undefined>): ResolvedSpec {
  const problems: string[] = [];
  if (!isObject(raw as Json)) throw usage("The spec must be a JSON object with prefix, nodes and connections");
  const spec = raw as unknown as PipelineSpec;
  if (typeof spec.prefix !== "string" || spec.prefix.length < 2) {
    problems.push('prefix must be a string of at least 2 characters, e.g. "hs:"; it scopes what apply may delete');
  }
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) problems.push("nodes must be a non-empty array");
  const nodes = new Map<string, ResolvedNode>();
  for (const [i, n] of (Array.isArray(spec.nodes) ? spec.nodes : []).entries()) {
    const where = `nodes[${i}]`;
    if (typeof n?.key !== "string" || !KEY.test(n.key)) {
      problems.push(`${where}.key must match ${KEY} (no colons: "key:port" addresses ports)`);
      continue;
    }
    if (nodes.has(n.key)) problems.push(`${where}: duplicate key "${n.key}"`);
    let factory = n.factory;
    let entry: CatalogueEntry | undefined;
    if (n.alias && n.factory) problems.push(`${where} (${n.key}): give alias or factory, not both`);
    if (n.alias) {
      entry = byAlias(n.alias);
      if (!entry) problems.push(`${where} (${n.key}): unknown alias "${n.alias}"; see \`knime nodes search\``);
      factory = entry?.factory;
    } else if (factory) {
      if (!isFactoryName(factory)) problems.push(`${where} (${n.key}): factory "${factory}" doesn't look like a class name`);
      entry = byFactory(factory);
    } else {
      problems.push(`${where} (${n.key}): needs alias or factory`);
    }
    if (n.settings !== undefined && !isObject(n.settings)) problems.push(`${where} (${n.key}): settings must be an object`);
    let settings: JsonObject | undefined;
    try {
      settings = n.settings && isObject(n.settings) ? (expandEnv(n.settings, env) as JsonObject) : undefined;
      if (n.preset !== undefined) {
        const ref = expandEnv(n.preset as Json, env) as PresetRef;
        settings = overlay(buildPreset(entry?.alias, ref).settings, settings ?? {});
      }
    } catch (e) {
      problems.push(`${where} (${n.key}): ${(e as Error).message}`);
    }
    nodes.set(n.key, { ...n, settings, factory: factory ?? "", entry, label: `${spec.prefix}${n.key}`, inputs: [], depth: 0 });
  }
  const connections: { from: Endpoint; to: Endpoint }[] = [];
  const fed = new Set<string>();
  for (const [i, c] of (spec.connections ?? []).entries()) {
    let from: Endpoint, to: Endpoint;
    try {
      from = parseEndpoint(String(c?.from));
      to = parseEndpoint(String(c?.to));
    } catch (e) {
      problems.push(`connections[${i}]: ${(e as Error).message}`);
      continue;
    }
    const src = nodes.get(from.key);
    const dst = nodes.get(to.key);
    if (!src) problems.push(`connections[${i}]: unknown node "${from.key}"`);
    if (!dst) problems.push(`connections[${i}]: unknown node "${to.key}"`);
    if (!src || !dst) continue;
    const slot = `${to.key}:${to.port}`;
    if (fed.has(slot)) problems.push(`connections[${i}]: ${slot} already has an input`);
    fed.add(slot);
    const checks = [
      { end: from, entry: src.entry, ports: src.entry?.out, side: "output" },
      { end: to, entry: dst.entry, ports: dst.entry?.in, side: "input" },
    ];
    for (const { end, entry, ports, side } of checks) {
      if (entry && ports && end.port > 0 && !ports.some((p) => p.index === end.port)) {
        problems.push(`connections[${i}]: ${entry.alias} has no ${side} port ${end.port} `
          + `(ports: ${ports.map((p) => `${p.index} ${p.name}`).join(", ") || "none"}; 0 is the flow-variable port)`);
      }
    }
    dst.inputs.push({ from, toPort: to.port });
    connections.push({ from, to });
  }
  const ordered = topoSort([...nodes.values()], problems);
  const sinks = ordered.filter((n) => !connections.some((c) => c.from.key === n.key)).map((n) => n.key);
  const run = spec.run ?? sinks;
  for (const k of run) if (!nodes.has(k)) problems.push(`run: unknown node "${k}"`);
  if (problems.length) {
    throw new CliError({
      code: "BAD_SPEC", exit: EXIT.USAGE,
      message: `The pipeline spec has ${problems.length} problem(s):\n- ${problems.join("\n- ")}`,
      hint: "See `knime guide apply` for the spec format.",
      details: problems,
    });
  }
  return { prefix: spec.prefix, nodes: ordered, connections, run };
}

function topoSort(nodes: ResolvedNode[], problems: string[]): ResolvedNode[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const out: ResolvedNode[] = [];
  const mark = new Map<string, "visiting" | "done">();
  const visit = (n: ResolvedNode, path: string[]): number => {
    const m = mark.get(n.key);
    if (m === "done") return n.depth;
    if (m === "visiting") {
      problems.push(`cycle: ${[...path, n.key].join(" → ")}`);
      return 0;
    }
    mark.set(n.key, "visiting");
    let depth = 0;
    for (const i of n.inputs) {
      const up = byKey.get(i.from.key);
      if (up) depth = Math.max(depth, visit(up, [...path, n.key]) + 1);
    }
    n.depth = depth;
    mark.set(n.key, "done");
    out.push(n);
    return depth;
  };
  for (const n of nodes) visit(n, []);
  return out;
}

export function downstreamKeys(spec: ResolvedSpec, key: string): string[] {
  const out = new Set<string>();
  const queue = [key];
  while (queue.length) {
    const k = queue.shift()!;
    for (const c of spec.connections) {
      if (c.from.key === k && !out.has(c.to.key)) {
        out.add(c.to.key);
        queue.push(c.to.key);
      }
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------
// Planner

export interface PlannedNode {
  key: string;
  label: string;
  factory: string;
  action: "add" | "reuse";
  id?: string;
  position?: { x: number; y: number };
}

export interface PlannedConnection {
  from: Endpoint;
  to: Endpoint;
  action: "connect" | "keep";
}

export interface ApplyPlan {
  prefix: string;
  remove: { id: string; label: string; reason: string }[];
  disconnect: { id: string; from: string; to: string; reason: string }[];
  nodes: PlannedNode[];
  connections: PlannedConnection[];
  run: string[];
}

const GRID_X = 170;
const GRID_Y = 140;

/**
 * What it takes to make the workflow match the spec. Only nodes whose label starts with the prefix are ever reused
 * or removed. A prefixed node is reused when its label is `<prefix><key>` and its factory matches; otherwise (or with
 * `rebuild`) it is removed and the node added again.
 */
export function planApply(spec: ResolvedSpec, snap: Snapshot, opts: { rebuild?: boolean } = {}): ApplyPlan {
  const ours = snap.withPrefix(spec.prefix);
  const remove: ApplyPlan["remove"] = [];
  const reuse = new Map<string, NodeView>();
  for (const n of ours) {
    const key = n.label!.slice(spec.prefix.length);
    const wanted = spec.nodes.find((s) => s.key === key);
    if (opts.rebuild) remove.push({ id: n.id, label: n.label!, reason: "--rebuild" });
    else if (!wanted) remove.push({ id: n.id, label: n.label!, reason: "not in the spec" });
    else if (n.factory !== wanted.factory) remove.push({ id: n.id, label: n.label!, reason: `factory changed (was ${n.factory ?? n.kind})` });
    else if (reuse.has(key)) remove.push({ id: n.id, label: n.label!, reason: `duplicate label (keeping ${reuse.get(key)!.id})` });
    else reuse.set(key, n);
  }

  const baseX = snap.maxX((n) => n.label?.startsWith(spec.prefix) ?? false) + 2 * GRID_X;
  const rowsAtDepth = new Map<number, number>();
  const nodes: PlannedNode[] = spec.nodes.map((s) => {
    const row = rowsAtDepth.get(s.depth) ?? 0;
    rowsAtDepth.set(s.depth, row + 1);
    const existing = reuse.get(s.key);
    if (existing) return { key: s.key, label: s.label, factory: s.factory, action: "reuse", id: existing.id };
    const [col, r] = s.at ?? [s.depth, row];
    return { key: s.key, label: s.label, factory: s.factory, action: "add", position: { x: baseX + col * GRID_X, y: 100 + r * GRID_Y } };
  });

  const idOf = (key: string) => reuse.get(key)?.id;
  const connections: PlannedConnection[] = spec.connections.map((c) => {
    const src = idOf(c.from.key);
    const dst = idOf(c.to.key);
    const exists = src !== undefined && dst !== undefined && snap.connections.some((x) =>
      x.sourceNode === src && x.sourcePort === c.from.port && x.destNode === dst && x.destPort === c.to.port);
    return { ...c, action: exists ? "keep" : "connect" };
  });

  // The spec owns the inputs of its nodes: an input it doesn't feed is disconnected. (A port it does feed is simply
  // reconnected, which replaces whatever was there.)
  const disconnect: ApplyPlan["disconnect"] = [];
  const removed = new Set(remove.map((r) => r.id));
  for (const [key, n] of reuse) {
    for (const x of snap.connections) {
      if (x.destNode !== n.id || removed.has(x.sourceNode)) continue;
      const fed = spec.connections.some((c) => c.to.key === key && c.to.port === x.destPort);
      if (!fed && x.id) {
        disconnect.push({ id: x.id, from: `${x.sourceNode}:${x.sourcePort}`, to: `${key}:${x.destPort}`, reason: "not in the spec" });
      }
    }
  }
  return { prefix: spec.prefix, remove, disconnect, nodes, connections, run: spec.run };
}

export function formatPlan(p: ApplyPlan): string[] {
  const lines: string[] = [];
  for (const r of p.remove) lines.push(`- remove ${r.id} [${r.label}] (${r.reason})`);
  for (const d of p.disconnect) lines.push(`- disconnect ${d.from} → ${d.to} (${d.reason})`);
  for (const n of p.nodes) {
    lines.push(n.action === "add" ? `+ add ${n.label} (${shortFactory(n.factory)})` : `= reuse ${n.id} [${n.label}]`);
  }
  for (const c of p.connections) {
    lines.push(`${c.action === "keep" ? "=" : "+"} ${c.action} ${c.from.key}:${c.from.port} → ${c.to.key}:${c.to.port}`);
  }
  lines.push(`> then run: ${p.run.join(", ")}`);
  return lines;
}

function shortFactory(f: string): string {
  return byFactory(f)?.alias ?? f.split(".").pop() ?? f;
}

// ---------------------------------------------------------------------------------------------------------------
// Executor

export interface ApplyResult {
  plan: ApplyPlan;
  ids: Record<string, string>;
  patched: { key: string; changed: boolean; changes: Change[] }[];
  run?: RunReport;
  warnings: string[];
}

export interface ApplyOptions {
  rebuild?: boolean;
  noRun?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export async function apply(session: Session, spec: ResolvedSpec, opts: ApplyOptions = {}): Promise<ApplyResult> {
  const log = opts.log ?? (() => {});
  const snap = await session.snapshot();
  const plan = planApply(spec, snap, opts);
  const result: ApplyResult = { plan, ids: {}, patched: [], warnings: [] };

  if (plan.remove.length) {
    const nodeIds = plan.remove.map((r) => r.id);
    // A running node can't be deleted.
    await session.api("/api/cancel", { nodeIds }, "cancel old nodes");
    await session.api("/api/wait", { nodeIds, waitMs: 30_000 }, "wait for cancel");
    await session.command({ kind: "delete", nodeIds, annotationIds: [], connectionIds: [] }, `delete ${nodeIds.length} old node(s)`);
    log(`removed ${nodeIds.length} node(s): ${plan.remove.map((r) => r.label).join(", ")}`);
  }
  if (plan.disconnect.length) {
    await session.command({ kind: "delete", nodeIds: [], annotationIds: [], connectionIds: plan.disconnect.map((d) => d.id) }, "disconnect");
  }

  const ids = result.ids;
  for (const n of plan.nodes) if (n.id) ids[n.key] = n.id;
  const executed = new Set<string>();

  for (const node of spec.nodes) {
    const planned = plan.nodes.find((p) => p.key === node.key)!;
    if (planned.action === "add") {
      ids[node.key] = await addLabelled(session, planned, snap, result.warnings);
      log(`added ${planned.label} as ${ids[node.key]}`);
    }
    for (const c of plan.connections.filter((x) => x.to.key === node.key && x.action === "connect")) {
      await session.command({
        kind: "connect", sourceNodeId: ids[c.from.key], sourcePortIdx: c.from.port,
        destinationNodeId: ids[c.to.key], destinationPortIdx: c.to.port,
      }, `connect ${c.from.key}:${c.from.port} → ${c.to.key}:${c.to.port}`);
    }
    if (!node.settings || Object.keys(node.settings).length === 0) continue;

    // Settings of most nodes only exist once their input has a spec, so run the direct inputs first.
    const ups = [...new Set(node.inputs.map((i) => ids[i.from.key]!))].filter((id) => !executed.has(id));
    if (ups.length && node.entry?.needsInputSpec !== false) {
      log(`running inputs of ${node.label} so its settings exist`);
      const r = await runNodes(session, ups, { timeoutMs: opts.timeoutMs });
      if (!r.ok) {
        throw new CliError({
          code: "NOT_EXECUTED", exit: EXIT.INCOMPLETE,
          message: `Inputs of ${node.label} didn't execute: ${r.notExecuted.map((n) => `${n.label ?? n.id}=${n.state}${n.message ? ` (${n.message.text})` : ""}`).join("; ")}`,
          hint: "Fix the upstream node (its settings or inputs) and re-run `knime apply`; finished nodes are reused.",
          details: r,
        });
      }
      ups.forEach((id) => executed.add(id));
    }
    const current = await session.api<Settings>("/api/node/settings", { nodeId: ids[node.key] }, `settings of ${node.label}`);
    if (Object.keys(current.model).length === 0) {
      throw new CliError({
        code: "EMPTY_MODEL", exit: EXIT.REJECTED,
        message: `${node.label} (${ids[node.key]}) shows no settings, so its spec settings can't be applied`,
        hint: node.inputs.length ? "Its inputs ran but gave it no table spec; check what they output." : "The node has no settings to set.",
      });
    }
    // An incomplete read is expected on a fresh tree learner, and its preset completes it; only what's still
    // incomplete after the set (or with nothing to set) is worth a warning.
    let complete = current.complete !== false;
    let problem = current.problem;
    let pp;
    try {
      pp = planObject(current.model, node.settings);
    } catch (e) {
      throw new CliError({ code: "AMBIGUOUS", exit: EXIT.USAGE, message: `${node.label}: ${(e as Error).message}` });
    }
    result.warnings.push(...pp.warnings.map((w) => `${node.label}: ${w}`));
    let changed = false;
    if (Object.keys(pp.patch).length) {
      const r = await session.api<SetResult>("/api/node/settings/set", { nodeId: ids[node.key], model: pp.patch }, `set ${node.label}`);
      changed = r.changed;
      complete = r.complete !== false;
      problem = r.problem;
      if (r.message?.type === "ERROR") result.warnings.push(`${node.label} after set: ${r.message.text}`);
      if (changed) log(`set ${node.label}:\n  ${formatChanges(pp.changes.filter((c) => c.kind !== "same")).join("\n  ")}`);
    }
    if (!complete) {
      result.warnings.push(`${node.label}: settings are still incomplete (${problem ?? "the node's own save failed"}); `
        + `add the missing keys with typed values, or use a preset (\`knime nodes info ${node.entry?.alias ?? "<alias>"}\`)`);
    }
    // A changed node resets itself and everything downstream.
    if (changed) for (const k of [node.key, ...downstreamKeys(spec, node.key)]) executed.delete(ids[k] ?? "");
    result.patched.push({ key: node.key, changed, changes: pp.changes });
  }

  if (!opts.noRun) {
    log(`running ${plan.run.join(", ")}`);
    result.run = await runNodes(session, plan.run.map((k) => ids[k]!), { timeoutMs: opts.timeoutMs });
  }
  return result;
}

/**
 * add_node then label. If the add times out (504, probably applied), the new node is found by diffing the workflow
 * and labelled anyway, so a re-run doesn't leave an unlabelled duplicate.
 */
async function addLabelled(session: Session, n: PlannedNode, before: Snapshot, warnings: string[]): Promise<string> {
  let id: string;
  try {
    const r = await session.command<{ newNodeId?: string }>(
      { kind: "add_node", nodeFactory: { className: n.factory }, position: n.position }, `add ${n.label}`);
    if (!r?.newNodeId) throw new CliError({ code: "ERROR", exit: EXIT.ERROR, message: `add ${n.label} returned no node id` });
    id = r.newNodeId;
  } catch (e) {
    if ((e as CliError).code !== "GATEWAY_TIMEOUT") throw e;
    const after = await session.snapshot();
    const known = new Set(before.nodes.map((x) => x.id));
    const fresh = after.nodes.filter((x) => !known.has(x.id) && !x.label && x.factory === n.factory);
    if (fresh.length !== 1) throw e;
    id = fresh[0]!.id;
    warnings.push(`add ${n.label} timed out but the node appeared as ${id}; labelled it and carried on`);
  }
  await session.command({ kind: "update_node_label", nodeId: id, label: n.label }, `label ${id}`);
  return id;
}
