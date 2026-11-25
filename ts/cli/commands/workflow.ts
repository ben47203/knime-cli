import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { str, type Command } from "../cli.ts";
import { byFactory } from "../catalogue.ts";
import { usage } from "../errors.ts";
import { svgSize, svgToPng } from "../render.ts";
import { specSummary } from "../ports.ts";
import type { InputPort, NodePorts, OutputPort, Projects } from "../types.ts";
import { projectState, saveLine } from "./project.ts";

export const workflowShow: Command = {
  path: ["workflow", "show"],
  tier: "READ",
  summary: "Nodes (id, label, name, state, message) and connections of the open workflow, and unsaved changes",
  options: {
    prefix: { type: "string", arg: "<label-prefix>", desc: "Only nodes whose label starts with this (connections between them)" },
    ports: { type: "boolean", desc: "Also list each node's ports and specs (0 is the flow-variable port); see `knime node ports`" },
  },
  notes: [
    "Without --project, uses the only open project, or the first one, and says which. Labels are the node",
    "annotations under each node; use them to address your nodes, since ids are reused after deletes.",
    "data.project has dirty (unsaved changes), canSave, saveBlocked (why not) and path.",
  ],
  examples: ["knime workflow show", "knime workflow show --prefix cal: --json"],
  async run(ctx) {
    const s = await ctx.session();
    const target = await s.target();
    const [{ projects }, snap, state] = await Promise.all([s.api<Projects>("/api/projects"), s.snapshot(), projectState(s)]);
    const prefix = str(ctx, "prefix");
    const nodes = prefix ? snap.withPrefix(prefix) : snap.nodes;
    const ids = new Set(nodes.map((n) => n.id));
    const connections = snap.connections.filter((c) => ids.has(c.sourceNode) && ids.has(c.destNode));
    const labelOf = (id: string) => snap.byId(id)?.label ?? id;
    const ports = new Map<string, NodePorts>();
    if (ctx.values.ports) {
      const all = await Promise.all(nodes.map((n) => s.ports(n.id).catch(() => undefined)));
      all.forEach((p, i) => p && ports.set(nodes[i]!.id, p));
    }
    const data = {
      project: { ...projects.find((p) => p.projectId === target.projectId), ...state },
      openProjects: projects,
      workflowId: target.workflowId,
      contentHash: snap.raw.contentHash,
      nodes: nodes.map((n) => ({
        id: n.id, label: n.label, name: n.name, kind: n.kind, factory: n.factory, alias: n.factory ? byFactory(n.factory)?.alias : undefined,
        state: n.state, message: n.message,
        ...(ctx.values.ports ? { inPorts: ports.get(n.id)?.inputs, outPorts: ports.get(n.id)?.outputs } : {}),
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
      `${data.project?.name ?? target.projectId} / ${target.workflowId}: ${nodes.length} node(s)${counts.size ? ` — ${[...counts].map(([k, v]) => `${v} ${k}`).join(", ")}` : ""}`,
      ...(state ? [`project ${saveLine(state)}`] : []),
      "",
      `${"id".padEnd(w.id)}  ${"label".padEnd(w.label)}  ${"name".padEnd(w.name)}  state`,
      ...nodes.flatMap((n) => {
        const lines = [`${n.id.padEnd(w.id)}  ${(n.label ?? "").padEnd(w.label)}  ${n.name.padEnd(w.name)}  ${n.state ?? "?"}${n.message ? `  ${n.message.type}: ${oneLine(n.message.text)}` : ""}`];
        const p = ports.get(n.id);
        if (p) {
          const brief = (x: InputPort | OutputPort) => `${[x.index, x.name].filter((v) => v !== undefined && v !== "").join(" ")} (${x.type}): ${specSummary(x.spec, x.reason)}`;
          lines.push(`    in:  ${p.inputs.map(brief).join(" | ") || "-"}`);
          lines.push(`    out: ${p.outputs.map(brief).join(" | ") || "-"}`);
        } else if (ctx.values.ports) {
          lines.push("    ports: unavailable (`knime node ports` says why)");
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

function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const workflowSvg: Command = {
  path: ["workflow", "svg"],
  tier: "READ",
  summary: "The workflow canvas as SVG (stdout, or -o file.svg), or as PNG with --png -o file.png",
  options: {
    output: { type: "string", short: "o", arg: "<file>", desc: "Write to this file (an -o ending in .png implies --png)" },
    png: { type: "boolean", desc: "Render to PNG with a headless browser (Chrome, Chromium, Edge or Playwright's); needs -o" },
    scale: { type: "string", arg: "<n>", desc: "With --png: pixels per SVG unit (default 1; 2 for a sharper image)" },
  },
  notes: [
    "Drawn by the renderer KNIME uses for the saved workflow preview: nodes, names, states, ports, connections and",
    "annotations, cropped to the nodes. --workflow <id> draws a metanode or component's inside instead.",
    "The SVG's text is HTML (foreignObject), so only a browser renders it faithfully; --png shells out to one.",
    "KNIME_CLI_BROWSER picks the browser. With --json and no -o, data.svg holds the SVG text.",
  ],
  examples: ["knime workflow svg -o canvas.svg", "knime workflow svg --png -o canvas.png --scale 2", "knime workflow svg > canvas.svg"],
  async run(ctx) {
    const out = str(ctx, "output");
    const png = Boolean(ctx.values.png) || Boolean(out && /\.png$/i.test(out));
    if (png && !out) throw usage("--png needs -o <file.png>: PNG bytes don't belong on a terminal");
    const scaleText = str(ctx, "scale");
    const scale = scaleText === undefined ? 1 : Number(scaleText);
    if (!(scale > 0 && scale <= 8)) throw usage("--scale must be a number between 0 and 8");
    if (scaleText !== undefined && !png) ctx.warn("--scale only applies with --png");
    const s = await ctx.session();
    await s.requireCapability("workflowSvg", "the canvas SVG");
    const r = await s.bytes("/api/workflow/svg", {}, "workflow svg");
    const svg = r.bytes.toString("utf8");
    const size = svgSize(svg);
    const target = await s.target();
    if (png) {
      if (/\.svg$/i.test(out!)) ctx.warn(`writing a PNG to ${out}, which is named .svg`);
      const bytes = await svgToPng(svg, { scale });
      await writeFile(out!, bytes);
      const px = size && { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
      return {
        data: { file: resolve(out!), contentType: "image/png", bytes: bytes.length, ...px, scale, workflowId: target.workflowId },
        text: [`wrote ${out} (PNG${px ? `, ${px.width} × ${px.height}` : ""}, ${bytes.length} bytes)`],
      };
    }
    if (out) {
      await writeFile(out, r.bytes);
      return {
        data: { file: resolve(out), contentType: r.contentType, bytes: r.bytes.length, ...size, workflowId: target.workflowId },
        text: [`wrote ${out} (SVG${size ? `, ${size.width} × ${size.height}` : ""}, ${r.bytes.length} bytes)`],
      };
    }
    return { data: { contentType: r.contentType, bytes: r.bytes.length, ...size, workflowId: target.workflowId, svg }, raw: svg };
  },
};
