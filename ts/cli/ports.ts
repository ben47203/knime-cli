/** Reading `/api/node/ports`: one-line descriptions of ports and specs, and finding image and table ports. */
import { CliError } from "./errors.ts";
import type { Session, Snapshot } from "./session.ts";
import type { ColumnSpec, InputPort, Json, NodePorts, OutputPort, PortSpec } from "./types.ts";

/** "4 columns", "PNG image", "flow variables", or the reason there's no spec. */
export function specSummary(spec: PortSpec | null, reason?: string): string {
  if (!spec) return reason ?? "no spec yet";
  switch (spec.kind) {
    case "table": return `${spec.columns?.length ?? 0} column(s)`;
    case "image": return `${spec.format ? spec.format.toUpperCase() : "an"} image`;
    case "flowVariables": return "flow variables";
    case "inactive": return "inactive branch";
    default: return spec.kind;
  }
}

function domain(c: ColumnSpec): string {
  const d = c.domain;
  if (!d) return "";
  const show = (v: Json | undefined) => (typeof v === "string" ? v : JSON.stringify(v));
  if (d.values?.length) {
    const more = d.valuesTruncated ? `, … (${d.valueCount ?? "more"})` : "";
    return ` {${d.values.slice(0, 8).map(show).join(", ")}${d.values.length > 8 && !d.valuesTruncated ? ", …" : more}}`;
  }
  if (d.lower !== undefined || d.upper !== undefined) return ` [${show(d.lower)}, ${show(d.upper)}]`;
  return "";
}

/** Human lines for one port, with its columns indented below. */
export function portLines(p: InputPort | OutputPort, snap?: Snapshot, columns = true): string[] {
  const name = (id: string) => {
    const label = snap?.byId(id)?.label;
    return label ? `${id} [${label}]` : id;
  };
  let link = "";
  if ("connected" in p) {
    if (p.connectedFrom) link = ` ← ${name(p.connectedFrom.nodeId)}:${p.connectedFrom.index}`;
  } else if (p.connectedTo.length) {
    link = ` → ${p.connectedTo.map((e) => `${name(e.nodeId)}:${e.index}`).join(", ")}`;
  }
  const lines = [`  ${[p.index, p.name].filter((x) => x !== undefined && x !== "").join(" ")} (${p.type}${p.optional ? ", optional" : ""})${link}: ${specSummary(p.spec, p.reason)}${p.summary ? ` — ${p.summary}` : ""}`];
  if (columns && p.spec?.kind === "table") {
    for (const c of p.spec.columns ?? []) lines.push(`      ${c.name}: ${c.type}${domain(c)}`);
  }
  return lines;
}

/** Output ports that carry an image (by spec, or by type before the node is configured). */
export function imageOutputs(ports: NodePorts): OutputPort[] {
  return ports.outputs.filter((p) => p.spec?.kind === "image" || /^image$/i.test(p.type));
}

/** The columns of a table port, or why there are none. */
export function tableColumns(port: InputPort | OutputPort | undefined): { columns?: ColumnSpec[]; reason?: string } {
  if (!port) return { reason: "no such port" };
  if (!port.spec) return { reason: port.reason ?? "no spec yet" };
  if (port.spec.kind !== "table") return { reason: `port ${port.index} is a ${port.type} port, not a table` };
  return { columns: port.spec.columns ?? [] };
}

const list = (ports: (InputPort | OutputPort)[]) => ports.map((p) => `${p.index}${p.name ? ` ${p.name}` : ""} (${p.type})`).join(", ") || "none";

/**
 * Connects two ports. If KNIME refuses ("Connection could not be created"), says which ports both nodes really have,
 * from node/ports, so a wrong index or type is plain to see.
 */
export async function connectExplained(s: Session, from: { node: string; port: number }, to: { node: string; port: number }, context: string): Promise<void> {
  try {
    await s.command({ kind: "connect", sourceNodeId: from.node, sourcePortIdx: from.port, destinationNodeId: to.node, destinationPortIdx: to.port }, context);
  } catch (e) {
    if (!(e instanceof CliError) || e.code !== "CONNECTION_FAILED") throw e;
    const [src, dst] = await Promise.all([s.ports(from.node).catch(() => undefined), s.ports(to.node).catch(() => undefined)]);
    if (!src || !dst) throw e;
    const out = src.outputs.find((p) => p.index === from.port);
    const into = dst.inputs.find((p) => p.index === to.port);
    const why = !out ? `${from.node} has no output port ${from.port}`
      : !into ? `${to.node} has no input port ${to.port}`
      : out.type !== into.type ? `output ${from.port} is ${out.type} but input ${to.port} takes ${into.type}` : "the port types look compatible (a cycle?)";
    throw new CliError({
      code: e.code, exit: e.exit, status: e.status, cause: e.why,
      message: `${e.message}: ${why}. ${from.node} outputs: ${list(src.outputs)}; ${to.node} inputs: ${list(dst.inputs)}`,
      hint: "Port 0 is the flow-variable port; data ports start at 1. `knime node ports <node>` shows both nodes' ports.",
    });
  }
}
