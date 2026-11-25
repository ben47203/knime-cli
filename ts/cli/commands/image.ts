/**
 * `knime node image`: the PNG or SVG on a node's image output port. With --enable it first turns a chart node's image
 * generation on: the `generateImage` setting, plus the port from its "Output Image" port group, which the dialog's
 * Apply would add but a settings set doesn't. Both come from KNIME's shared chart settings, so this works for any
 * chart node that has them, not a list of factories.
 */
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { arg, seconds, str, warnIfDirtyBeforeReset, type Command, type Ctx } from "../cli.ts";
import { CliError, EXIT, usage } from "../errors.ts";
import { formatReport, runNodes } from "../execute.ts";
import { formatChanges, planObject, type Change } from "../patch.ts";
import { flatten } from "../paths.ts";
import { imageOutputs } from "../ports.ts";
import { svgSize } from "../render.ts";
import type { NodeView, Session, Snapshot } from "../session.ts";
import type { JsonObject, SetResult, Settings } from "../types.ts";

/** The port group KNIME's chart settings (ModelSettingsWithImageGeneration) declare for the image output. */
export const IMAGE_PORT_GROUP = "Output Image";
export const IMAGE_PORT_TYPE = "org.knime.core.node.port.image.ImagePortObject";

const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/svg+xml": ".svg" };

export function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType.split(";")[0]!.trim().toLowerCase()] ?? ".bin";
}

/** Width and height of a PNG (from its IHDR chunk) or an SVG. */
export function imageSize(contentType: string, bytes: Buffer): { width: number; height: number } | undefined {
  if (extensionFor(contentType) === ".png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (extensionFor(contentType) === ".svg") return svgSize(bytes.toString("utf8"));
  return undefined;
}

/** The settings path of `generateImage` (top level on the chart nodes seen so far), or undefined. */
export function generateImagePath(model: JsonObject): string | undefined {
  const leaves = flatten(model).filter((l) => l.path === "generateImage" || l.path.endsWith(".generateImage"));
  return leaves.sort((a, b) => a.path.length - b.path.length)[0]?.path;
}

interface EnableOptions {
  format?: "PNG" | "SVG";
  width?: number;
  height?: number;
  timeoutMs: number;
}

export interface EnableResult {
  portAdded: boolean;
  /** The image port's index after enabling. */
  port?: number;
  changed: boolean;
  changes: Change[];
  ran: boolean;
}

function hasImagePort(snap: Snapshot, id: string): number | undefined {
  const ports = snap.raw.workflow.nodes?.[id]?.outPorts ?? [];
  return ports.find((p) => p.portGroupId === IMAGE_PORT_GROUP || p.typeId === IMAGE_PORT_TYPE)?.index;
}

async function enableImage(ctx: Ctx, s: Session, snap: Snapshot, n: NodeView, o: EnableOptions): Promise<EnableResult> {
  const st = await s.api<Settings>("/api/node/settings", { nodeId: n.id }, `settings of ${n.id}`);
  const path = generateImagePath(st.model);
  if (!path) {
    throw new CliError({
      code: "NO_IMAGE_SETTING", exit: EXIT.REJECTED,
      message: `${n.id}${n.label ? ` [${n.label}]` : ""} ${n.name} has no generateImage setting, so it can't make an image`,
      hint: Object.keys(st.model).length === 0
        ? "Its settings are empty: connect its input (and run upstream) first, then retry."
        : "Chart nodes built on KNIME's current views (Bar Chart, Line Plot, Scatter Plot, …) have it; check with `knime node settings <node> --filter generateImage`.",
    });
  }
  const prefix = path.slice(0, -"generateImage".length);
  const keys = new Set(flatten(st.model).map((l) => l.path));
  const patch: JsonObject = { [path]: true };
  const want: [string, string | number | undefined][] = [["imageFormat", o.format], ["width", o.width], ["height", o.height]];
  for (const [key, value] of want) {
    if (value === undefined) continue;
    if (!keys.has(prefix + key)) throw usage(`${n.id} has no ${prefix + key} setting; leave out --${key === "imageFormat" ? "format" : key}`);
    patch[prefix + key] = value;
  }

  let port = hasImagePort(snap, n.id);
  const portAdded = port === undefined;
  if (portAdded) {
    const r = await s.command<{ newPortIdx?: number }>(
      { kind: "add_port", nodeId: n.id, side: "output", portGroup: IMAGE_PORT_GROUP, portTypeId: IMAGE_PORT_TYPE },
      `add the ${IMAGE_PORT_GROUP} port to ${n.id}`);
    port = r?.newPortIdx;
    ctx.log(`added the ${IMAGE_PORT_GROUP} port to ${n.id}${port !== undefined ? ` as output ${port}` : ""}`);
  }

  // Read again: adding a port can replace the node's settings object.
  const current = portAdded ? await s.api<Settings>("/api/node/settings", { nodeId: n.id }, `settings of ${n.id}`) : st;
  const plan = planObject(current.model, patch, { exact: true });
  const changing = plan.changes.filter((c) => c.kind !== "same");
  let changed = false;
  if (changing.length) {
    warnIfDirtyBeforeReset(ctx, snap.dirty);
    const r = await s.api<SetResult>("/api/node/settings/set", { nodeId: n.id, model: plan.patch }, `set ${n.id}`);
    changed = r.changed;
    ctx.log(`set ${n.id}:\n  ${formatChanges(changing).join("\n  ")}`);
  }
  const fresh = await s.snapshot();
  let ran = false;
  if (fresh.byId(n.id)?.state !== "EXECUTED") {
    ctx.log(`running ${n.id}`);
    const report = await runNodes(s, [n.id], { timeoutMs: o.timeoutMs });
    if (!report.ok) {
      throw new CliError({
        code: report.done ? "NOT_EXECUTED" : "TIMEOUT", exit: EXIT.INCOMPLETE,
        message: `${n.id} didn't execute, so it has no image:\n${formatReport(report).join("\n")}`,
        hint: "Fix the chart's settings (e.g. its category and value columns) or its input, then retry.",
        details: report,
      });
    }
    ran = true;
  }
  return { portAdded, port, changed, changes: plan.changes, ran };
}

export const nodeImage: Command = {
  path: ["node", "image"],
  tier: "READ",
  tierWith: (v) => (v.enable ? "EXEC" : "READ"),
  summary: "Save the PNG or SVG from a node's image output port; --enable turns a chart node's image on and runs it",
  args: "<node>",
  options: {
    port: { type: "string", arg: "<n>", desc: "Output port (default: the first image port, from `knime node ports`)" },
    output: { type: "string", short: "o", arg: "<file>", desc: "Where to write it (default: <label or id>.<png|svg> here)" },
    enable: { type: "boolean", desc: "Chart nodes: set generateImage, add the Output Image port if missing, then run the node" },
    format: { type: "string", arg: "<PNG|SVG>", desc: "With --enable: the image format (the node's default otherwise)" },
    width: { type: "string", arg: "<px>", desc: "With --enable: image width" },
    height: { type: "string", arg: "<px>", desc: "With --enable: image height" },
    timeout: { type: "string", arg: "<seconds>", desc: "With --enable: how long to wait for the node to run (default 300)" },
  },
  notes: [
    "Tier: READ, or EXEC with --enable (it changes settings, which resets the node and its downstream, and runs it).",
    "The file's extension follows the image's content type; with --enable, -o x.svg or x.png also picks the format.",
    "Chart nodes (Bar Chart, Line Plot, …) only make an image once generateImage is on and their Output Image port",
    "exists; a settings set doesn't add the port, --enable does.",
  ],
  examples: [
    "knime node image my:chart --enable -o chart.png",
    "knime node image my:chart --enable --format SVG --width 1200 --height 800 -o chart.svg",
    "knime node image root:7 --port 1 --json",
  ],
  async run(ctx) {
    const portText = str(ctx, "port");
    const wanted = portText === undefined ? undefined : Number(portText);
    if (wanted !== undefined && !(Number.isInteger(wanted) && wanted >= 0)) throw usage("--port must be a port number (0 is the flow-variable port)");
    const out = str(ctx, "output");
    // With --enable, -o chart.svg asks for an SVG.
    const fromName = ctx.values.enable && out ? ({ ".png": "PNG", ".svg": "SVG" } as Record<string, string>)[extname(out).toLowerCase()] : undefined;
    const formatText = str(ctx, "format")?.toUpperCase() ?? fromName;
    if (formatText !== undefined && formatText !== "PNG" && formatText !== "SVG") throw usage("--format must be PNG or SVG");
    const size = (name: "width" | "height") => {
      const v = str(ctx, name);
      if (v === undefined) return undefined;
      const x = Number(v);
      if (!(Number.isInteger(x) && x > 0)) throw usage(`--${name} must be a positive whole number of pixels`);
      return x;
    };
    const width = size("width");
    const height = size("height");
    const enable = Boolean(ctx.values.enable);
    if (!enable && (str(ctx, "format") || width || height)) throw usage("--format, --width and --height need --enable");

    const s = await ctx.session();
    const snap = await s.snapshot();
    const n = snap.resolve(arg(ctx, 0, "node"));
    const enabled = enable
      ? await enableImage(ctx, s, snap, n, { format: formatText as EnableOptions["format"], width, height, timeoutMs: seconds(ctx, "timeout", 300) })
      : undefined;

    let port = wanted;
    if (port === undefined) {
      const images = imageOutputs(await s.ports(n.id));
      port = images[0]?.index ?? enabled?.port;
      if (port === undefined) {
        const st = await s.api<Settings>("/api/node/settings", { nodeId: n.id }, `settings of ${n.id}`).catch(() => undefined);
        throw new CliError({
          code: "NO_IMAGE_PORT", exit: EXIT.NOT_FOUND,
          message: `${n.id}${n.label ? ` [${n.label}]` : ""} ${n.name} has no image output port`,
          hint: st && generateImagePath(st.model)
            ? `It's a chart node with image generation off: \`knime node image ${n.label ?? n.id} --enable\` turns it on and runs it.`
            : "Only nodes with an Image output port make images; `knime node ports <node>` lists its ports.",
        });
      }
    }
    const img = await s.bytes("/api/node/port/image", { nodeId: n.id, port }, `image of ${n.id}:${port}`);
    const ext = extensionFor(img.contentType);
    let file = out ?? `${(n.label ?? n.id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "image"}${ext}`;
    if (!extname(file)) file += ext;
    else if (extname(file).toLowerCase() !== ext) ctx.warn(`the image is ${ext.slice(1).toUpperCase()}, but ${file} is named ${extname(file)}`);
    await writeFile(file, img.bytes);
    const dims = imageSize(img.contentType, img.bytes);
    return {
      data: { node: { id: n.id, label: n.label, name: n.name }, port, file: resolve(file), contentType: img.contentType, bytes: img.bytes.length, ...dims, enabled },
      text: [
        ...(enabled ? [
          `${enabled.portAdded ? `added the ${IMAGE_PORT_GROUP} port; ` : ""}${enabled.changed ? "image generation set" : "settings already matched"}${enabled.ran ? "; ran the node" : ""}`,
        ] : []),
        `wrote ${file} (${ext.slice(1).toUpperCase()}${dims ? `, ${dims.width} × ${dims.height}` : ""}, ${img.bytes.length} bytes) from ${n.id}:${port}`,
      ],
    };
  },
};
