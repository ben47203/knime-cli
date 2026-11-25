import { str, type Command } from "../cli.ts";
import { byFactory } from "../catalogue.ts";
import type { Projects } from "../types.ts";

export const workflowShow: Command = {
  path: ["workflow", "show"],
  tier: "READ",
  summary: "Nodes (id, label, name, state, message) and connections of the open workflow",
  options: {
    prefix: { type: "string", arg: "<label-prefix>", desc: "Only nodes whose label starts with this (connections between them)" },
    ports: { type: "boolean", desc: "Also list each node's ports (0 is the flow-variable port)" },
  },
  notes: [
    "Without --project, uses the only open project, or the first one, and says which. Labels are the node",
    "annotations under each node; use them to address your nodes, since ids are reused after deletes.",
  ],
  examples: ["knime workflow show", "knime workflow show --prefix cal: --json"],
  async run(ctx) {
    const s = await ctx.session();
    const target = await s.target();
    const { projects } = await s.api<Projects>("/api/projects");
    const snap = await s.snapshot();
    const prefix = str(ctx, "prefix");
    const nodes = prefix ? snap.withPrefix(prefix) : snap.nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const connections = snap.connections.filter((c) => ids.has(c.sourceNode) && ids.has(c.destNode));
    const labelOf = (id: string) => snap.byId(id)?.label ?? id;
    const raw = snap.raw.workflow.nodes ?? {};
    const data = {
      project: projects.find((p) => p.projectId === target.projectId),
      openProjects: projects,
      workflowId: target.workflowId,
      contentHash: snap.raw.contentHash,
      nodes: nodes.map((n) => ({
        id: n.id, label: n.label, name: n.name, kind: n.kind, factory: n.factory, alias: n.factory ? byFactory(n.factory)?.alias : undefined,
        state: n.state, message: n.message,
        ...(ctx.values.ports ? { inPorts: raw[n.id]?.inPorts?.map(portInfo), outPorts: raw[n.id]?.outPorts?.map(portInfo) } : {}),
      })),
      connections: connections.map((c) => ({ from: `${c.sourceNode}:${c.sourcePort}`, to: `${c.destNode}:${c.destPort}`, id: c.id })),
    };
    const order = (id: string) => Number(id.split(":").pop());
    connections.sort((a, b) => order(a.destNode) - order(b.destNode) || a.destPort - b.destPort);
    const w = {
      id: Math.max(4, ...nodes.map((n) => n.id.length)),
      label: Math.max(5, ...nodes.map((n) => (n.label ?? "").length)),
      name: Math.max(4, ...nodes.map((n) => n.name.length)),
    };
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.state ?? "?", (counts.get(n.state ?? "?") ?? 0) + 1);
    const text = [
      `${data.project?.name ?? target.projectId} / ${target.workflowId}: ${nodes.length} node(s) — ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}`,
      "",
      `${"id".padEnd(w.id)}  ${"label".padEnd(w.label)}  ${"name".padEnd(w.name)}  state`,
      ...nodes.flatMap((n) => {
        const lines = [`${n.id.padEnd(w.id)}  ${(n.label ?? "").padEnd(w.label)}  ${n.name.padEnd(w.name)}  ${n.state ?? "?"}${n.message ? `  ${n.message.type}: ${oneLine(n.message.text)}` : ""}`];
        if (ctx.values.ports) {
          const r = raw[n.id];
          lines.push(`           in:  ${(r?.inPorts ?? []).map((p) => `${p.index} ${p.name ?? ""}`).join(" | ") || "-"}`);
          lines.push(`           out: ${(r?.outPorts ?? []).map((p) => `${p.index} ${p.name ?? ""}${p.info && p.index > 0 ? ` (${p.info})` : ""}`).join(" | ") || "-"}`);
        }
        return lines;
      }),
      "",
      `connections (${connections.length}):`,
      ...connections.map((c) => `  ${labelOf(c.sourceNode)}:${c.sourcePort} → ${labelOf(c.destNode)}:${c.destPort}`),
    ];
    return { data, text };
  },
};

function portInfo(p: { index: number; name?: string; typeId?: string; info?: string; connectedVia?: string[] }) {
  return { index: p.index, name: p.name, type: p.typeId?.split(".").pop(), info: p.info, connections: p.connectedVia?.length ?? 0 };
}

function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
