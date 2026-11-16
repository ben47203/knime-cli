import { readFile } from "node:fs/promises";

import { byAlias, byFactory, isFactoryName, search } from "../catalogue.ts";
import { arg, str, type Command, type Ctx } from "../cli.ts";
import { CliError, EXIT, usage } from "../errors.ts";
import { formatChanges, parseAssignment, planAssignments, planObject, PatchError, type PatchPlan } from "../patch.ts";
import { flatten, isObject } from "../paths.ts";
import type { NodeView, Session } from "../session.ts";
import type { JsonObject, SetResult, Settings } from "../types.ts";

function resolveFactory(text: string): { factory: string; alias?: string } {
  const e = byAlias(text);
  if (e) return { factory: e.factory, alias: e.alias };
  if (isFactoryName(text)) return { factory: text, alias: byFactory(text)?.alias };
  const near = search(text.replace(/[-_]/g, " ")).slice(0, 5).map((x) => x.alias);
  throw new CliError({
    code: "ALIAS_NOT_FOUND", exit: EXIT.NOT_FOUND, message: `"${text}" is neither a catalogue alias nor a factory class name`,
    hint: near.length ? `Did you mean: ${near.join(", ")}? (\`knime nodes search ${text}\`)` : "See `knime nodes search <text>`, or pass the full factory class name.",
  });
}

function describe(n: NodeView): string {
  return `${n.id}${n.label ? ` [${n.label}]` : ""} ${n.name}`;
}

export const nodeAdd: Command = {
  path: ["node", "add"],
  tier: "WRITE",
  summary: "Add a node by catalogue alias or factory class name, optionally labelled and wired",
  args: "<alias|factory>",
  options: {
    label: { type: "string", arg: "<text>", desc: "Label to put under the node (recommended: a prefix of yours, e.g. my:reader)" },
    at: { type: "string", arg: "<x,y>", desc: "Position in workflow coordinates (default: right of everything)" },
    from: { type: "string", arg: "<node[:port]>", desc: "Connect this output (port default 1) to the new node's input 1" },
  },
  notes: ["Undoable in KNIME (it's a workflow command). Factories depend on the running KNIME's installed extensions."],
  examples: ["knime node add csv-reader --label my:reader", "knime node add missing-value --label my:missing --from my:reader"],
  async run(ctx) {
    const { factory, alias } = resolveFactory(arg(ctx, 0, "alias or factory"));
    const s = await ctx.session();
    const snap = await s.snapshot();
    const from = str(ctx, "from") ? snap.resolvePort(str(ctx, "from")!) : undefined;
    let position = { x: snap.maxX() + 200, y: 100 };
    const at = str(ctx, "at");
    if (at) {
      const m = /^(-?\d+),(-?\d+)$/.exec(at);
      if (!m) throw usage("--at must be x,y");
      position = { x: Number(m[1]), y: Number(m[2]) };
    } else if (from?.node.position) {
      position = { x: from.node.position.x + 170, y: from.node.position.y };
    }
    const label = str(ctx, "label");
    if (label && snap.withLabel(label).length) ctx.warn(`label "${label}" is already on ${snap.withLabel(label).map((n) => n.id).join(", ")}`);
    const r = await s.command<{ newNodeId: string }>({ kind: "add_node", nodeFactory: { className: factory }, position }, `add ${alias ?? factory}`);
    const id = r.newNodeId;
    if (label) await s.command({ kind: "update_node_label", nodeId: id, label }, `label ${id}`);
    if (from) {
      await s.command({ kind: "connect", sourceNodeId: from.node.id, sourcePortIdx: from.port, destinationNodeId: id, destinationPortIdx: 1 }, `connect ${from.node.id}:${from.port} → ${id}:1`);
    }
    if (!label) ctx.warn("no --label: label your nodes so later runs can find them (ids are reused after deletes)");
    return { data: { id, label, factory, alias, position, connectedFrom: from && `${from.node.id}:${from.port}` }, text: [`added ${id}${label ? ` [${label}]` : ""} (${alias ?? factory})`] };
  },
};

export const nodeConnect: Command = {
  path: ["node", "connect"],
  tier: "WRITE",
  summary: "Connect an output port to an input port (ports default to 1; 0 is the flow-variable port)",
  args: "<from[:port]> <to[:port]>",
  notes: [
    "A connection into an occupied input replaces the old one. \"Connection could not be created\" usually means a",
    "wrong port: check with `knime workflow show --ports` or `knime nodes info <alias>`.",
  ],
  examples: ["knime node connect my:partition:1 my:learner", "knime node connect root:3:2 root:5:2"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const from = snap.resolvePort(arg(ctx, 0, "source node"));
    const to = snap.resolvePort(arg(ctx, 1, "destination node"));
    if (from.port >= from.node.outPorts && from.node.outPorts) ctx.warn(`${describe(from.node)} has output ports 0..${from.node.outPorts - 1}`);
    if (to.port >= to.node.inPorts && to.node.inPorts) ctx.warn(`${describe(to.node)} has input ports 0..${to.node.inPorts - 1}`);
    await s.command({ kind: "connect", sourceNodeId: from.node.id, sourcePortIdx: from.port, destinationNodeId: to.node.id, destinationPortIdx: to.port },
      `connect ${from.node.id}:${from.port} → ${to.node.id}:${to.port}`);
    return { data: { from: `${from.node.id}:${from.port}`, to: `${to.node.id}:${to.port}` }, text: [`connected ${describe(from.node)}:${from.port} → ${describe(to.node)}:${to.port}`] };
  },
};

export const nodeLabel: Command = {
  path: ["node", "label"],
  tier: "WRITE",
  summary: "Set the label (annotation) under a node; labels are how you find your nodes again",
  args: "<node> <label>",
  examples: ["knime node label root:7 my:reader"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const n = snap.resolve(arg(ctx, 0, "node"));
    const label = arg(ctx, 1, "label");
    const clash = snap.withLabel(label).filter((x) => x.id !== n.id);
    if (clash.length) ctx.warn(`label "${label}" is also on ${clash.map((x) => x.id).join(", ")}`);
    await s.command({ kind: "update_node_label", nodeId: n.id, label }, `label ${n.id}`);
    return { data: { id: n.id, label, previous: n.label }, text: [`${n.id}: ${n.label ? `"${n.label}" → ` : ""}"${label}"`] };
  },
};

export const nodeRm: Command = {
  path: ["node", "rm"],
  tier: "WRITE",
  summary: "Delete nodes by id/label, or every node whose label starts with --prefix",
  args: "[nodes…]",
  options: {
    prefix: { type: "string", arg: "<label-prefix>", desc: "Delete every node whose label starts with this (at least 2 characters)" },
    force: { type: "boolean", desc: "Allow deleting unlabelled nodes" },
    "dry-run": { type: "boolean", desc: "Only list what would be deleted" },
  },
  notes: [
    "Refuses (exit 9) to delete unlabelled nodes without --force, and never deletes everything: there's no --all.",
    "Running nodes are cancelled first. Undoable in KNIME (one delete command).",
  ],
  examples: ["knime node rm my:reader", "knime node rm --prefix my: --dry-run"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const prefix = str(ctx, "prefix");
    if (prefix !== undefined && prefix.length < 2) {
      throw new CliError({ code: "REFUSED", exit: EXIT.REFUSED, message: "--prefix must be at least 2 characters", hint: "Use your own label prefix, e.g. my:" });
    }
    const nodes = [...(prefix ? snap.withPrefix(prefix) : []), ...ctx.positionals.map((p) => snap.resolve(p))];
    const unique = [...new Map(nodes.map((n) => [n.id, n])).values()];
    if (!unique.length) {
      if (!prefix) throw usage("Name the nodes to delete, or pass --prefix");
      return { data: { deleted: [] }, text: [`no nodes labelled ${prefix}*`] };
    }
    const unlabelled = unique.filter((n) => !n.label);
    if (unlabelled.length && !ctx.values.force) {
      throw new CliError({
        code: "REFUSED", exit: EXIT.REFUSED,
        message: `Refusing to delete unlabelled node(s): ${unlabelled.map(describe).join(", ")}`,
        hint: "They may not be yours. Label them first, or pass --force if you're sure.",
      });
    }
    const list = unique.map((n) => ({ id: n.id, label: n.label, name: n.name }));
    if (ctx.values["dry-run"]) return { data: { wouldDelete: list }, text: ["would delete:", ...unique.map((n) => `  ${describe(n)}`)] };
    const nodeIds = unique.map((n) => n.id);
    const busy = unique.filter((n) => n.state === "EXECUTING" || n.state === "QUEUED").map((n) => n.id);
    if (busy.length) {
      await s.api("/api/cancel", { nodeIds: busy }, "cancel");
      await s.api("/api/wait", { nodeIds: busy, waitMs: 30_000 }, "wait for cancel");
    }
    await s.command({ kind: "delete", nodeIds, annotationIds: [], connectionIds: [] }, `delete ${nodeIds.length} node(s)`);
    return { data: { deleted: list }, text: [`deleted ${unique.length} node(s):`, ...unique.map((n) => `  ${describe(n)}`)] };
  },
};

async function getSettings(s: Session, n: NodeView): Promise<Settings> {
  return s.api<Settings>("/api/node/settings", { nodeId: n.id }, `settings of ${n.id}`);
}

/** Warnings every settings read should surface. */
function settingsWarnings(ctx: Ctx, st: Settings, n: NodeView, upstreamNotRun: boolean): void {
  if (st.redacted.length) ctx.warn(`${st.redacted.length} secret(s) redacted and not settable: ${st.redacted.join(", ")}`);
  if (st.complete === false) {
    ctx.warn(`the model is incomplete: the node's own save failed${st.problem ? ` (${st.problem})` : ""}, so keys are missing and patches may fail (tree learners do this)`);
  }
  if (Object.keys(st.model).length === 0) {
    ctx.warn(n.inPorts > 1 && upstreamNotRun
      ? "empty model: this node only shows settings once its input has a table spec; run upstream first (`knime run <upstream>`)"
      : "empty model: the node has no settings, or its input has no table spec yet");
  }
}

export const nodeSettings: Command = {
  path: ["node", "settings"],
  tier: "READ",
  summary: "A node's settings, flattened to dot-paths (or the raw response with --json)",
  args: "<node>",
  options: {
    filter: { type: "string", arg: "<text>", desc: "Only paths containing this text" },
    variables: { type: "boolean", desc: "Also list flow-variable bindings (read-only)" },
  },
  notes: [
    "Keys with null values are hidden by the server (e.g. Java Snippet `expression`), but `node set` accepts them.",
    "Secrets show as {\"$redacted\": true}. A node shows no settings until its input has a table spec.",
  ],
  examples: ["knime node settings my:reader", "knime node settings root:4 --filter seed", "knime node settings 7 --json"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const n = snap.resolve(arg(ctx, 0, "node"));
    const st = await getSettings(s, n);
    const upstreamNotRun = snap.upstream(n.id).some((id) => snap.byId(id)?.state !== "EXECUTED");
    settingsWarnings(ctx, st, n, upstreamNotRun);
    const filter = str(ctx, "filter");
    const leaves = flatten(st.model).filter((l) => !filter || l.path.includes(filter));
    const vars = ctx.values.variables ? flatten(st.variables) : [];
    return {
      data: { node: { id: n.id, label: n.label, name: n.name }, ...st },
      text: [
        `${describe(n)} (${st.kind})`,
        ...leaves.map((l) => `${l.path} = ${JSON.stringify(l.value)}`),
        ...(vars.length ? ["", "flow-variable bindings (read-only):", ...vars.map((l) => `  ${l.path} = ${JSON.stringify(l.value)}`)] : []),
      ],
    };
  },
};

export const nodeSet: Command = {
  path: ["node", "set"],
  tier: "WRITE",
  summary: "Patch a node's settings with path=value (JSON values), path:type=value, or --patch file.json",
  args: "<node> [path[:type]=value…]",
  options: {
    patch: { type: "string", arg: "<file.json>", desc: "A JSON object of settings to patch (nested or dot-path keys)" },
    "dry-run": { type: "boolean", desc: "Show the diff and what would be reset, change nothing" },
    exact: { type: "boolean", desc: "Don't expand path suffixes; paths must be complete" },
  },
  notes: [
    "Values parse as JSON (80, true, [\"a\",\"b\"], null), else as text; an existing string setting stays a string.",
    "Types: string int long short byte double float boolean char, <type>[] (JSON array), config, config[], json.",
    "A typed key the node doesn't have yet is sent as {\"$type\": <type>, \"value\": …}, which newer servers create.",
    "A unique suffix is enough: source.path.path=/x.csv. The patch is all-or-nothing.",
    "WARNING: a change resets this node and everything downstream, and can't be undone. An open dialog for the",
    "node in KNIME keeps stale values; close it first. A patch that changes nothing keeps results.",
  ],
  examples: [
    "knime node set my:partition percentage=80 seed=42 seed_is_present=true --dry-run",
    "knime node set my:reader source.path.path=/data/housing.csv",
    "knime node set my:pred custom_prediction_name:string=pred_linear",
    "knime node set my:missing --patch missing.json",
  ],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const n = snap.resolve(arg(ctx, 0, "node"));
    const assignments = ctx.positionals.slice(1);
    const file = str(ctx, "patch");
    if (!assignments.length && !file) throw usage("Give path=value assignments or --patch file.json");
    const st = await getSettings(s, n);
    settingsWarnings(ctx, st, n, snap.upstream(n.id).some((id) => snap.byId(id)?.state !== "EXECUTED"));
    let plan: PatchPlan;
    try {
      const opts = { exact: Boolean(ctx.values.exact) };
      const parts: PatchPlan[] = [];
      if (file) {
        const obj: unknown = JSON.parse(await readFile(file, "utf8"));
        if (!isObject(obj as never)) throw usage(`${file} must hold a JSON object`);
        parts.push(planObject(st.model, obj as JsonObject, opts));
      }
      if (assignments.length) parts.push(planAssignments(st.model, assignments.map(parseAssignment), opts));
      plan = merge(parts);
    } catch (e) {
      if (e instanceof CliError) throw e;
      throw new CliError({ code: e instanceof PatchError ? "AMBIGUOUS" : "USAGE", exit: EXIT.USAGE, message: (e as Error).message, hint: "See `knime guide settings` for the path syntax." });
    }
    for (const w of plan.warnings) ctx.warn(w);
    const changing = plan.changes.filter((c) => c.kind !== "same");
    const downstream = snap.downstream(n.id);
    const resetNote = `${changing.length ? "applying resets" : "would reset"} ${n.id} and ${downstream.length} downstream node(s); settings changes can't be undone`;
    const diff = formatChanges(plan.changes);
    if (ctx.values["dry-run"] || !changing.length) {
      if (changing.length) ctx.warn(resetNote.replace("applying resets", "would reset"));
      return {
        data: { node: n.id, dryRun: Boolean(ctx.values["dry-run"]), changed: false, changes: plan.changes, patch: plan.patch, resets: changing.length ? [n.id, ...downstream] : [] },
        text: [...diff, changing.length ? `(dry run: nothing sent)` : "nothing to change"],
      };
    }
    const r = await s.api<SetResult>("/api/node/settings/set", { nodeId: n.id, model: plan.patch }, `set ${n.id}`);
    if (r.changed) ctx.warn(resetNote);
    if (r.message?.type === "ERROR") ctx.warn(`${n.id} after set: ${r.message.text}`);
    return {
      data: { node: n.id, changed: r.changed, state: r.state, message: r.message, changes: plan.changes, resets: r.changed ? [n.id, ...downstream] : [] },
      text: [...diff, `${r.changed ? "changed" : "unchanged"}; ${n.id} is now ${r.state}${r.message ? ` (${r.message.type}: ${r.message.text})` : ""}`],
    };
  },
};

function merge(parts: PatchPlan[]): PatchPlan {
  if (parts.length === 1) return parts[0]!;
  const changes = parts.flatMap((p) => p.changes);
  const patch: JsonObject = {};
  const deep = (t: JsonObject, src: JsonObject) => {
    for (const [k, v] of Object.entries(src)) {
      const cur = t[k];
      if (isObject(v) && isObject(cur) && !("$type" in v)) deep(cur, v);
      else t[k] = v;
    }
  };
  for (const p of parts) deep(patch, p.patch);
  return { patch, changes, warnings: parts.flatMap((p) => p.warnings) };
}
