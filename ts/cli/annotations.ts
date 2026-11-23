/**
 * Workflow annotations: the coloured boxes on the canvas. KNIME ids (`root_3`) are positions in the workflow's
 * annotation list and are reused after a delete, so the CLI tags the annotations it writes with a visible last
 * paragraph, `[[<tag>]]`, and finds them again by that tag, the way nodes are found by label.
 */
import { CliError, EXIT, usage } from "./errors.ts";
import type { NodeView } from "./session.ts";
import { htmlToText, textToHtml } from "./text.ts";
import type { WorkflowAnnotationEnt } from "./types.ts";

/** KNIME's annotation border colours, as the modern UI's colour picker names them. */
export const PALETTE: Readonly<Record<string, string>> = {
  None: "#FFFFFF",
  SilverSand: "#C0C4C6",
  DoveGray: "#6E6E6E",
  AquamarineDark: "#2B94B1",
  CornflowerDark: "#1A417A",
  Yellow: "#FFD800",
  Carrot: "#FF9632",
  Coral: "#FF4B4B",
  MeadowLight: "#C8E632",
  Meadow: "#3CB44B",
  Avocado: "#CBD9A9",
  Petrol: "#469990",
  PetrolDark: "#005559",
  Wood: "#D2A384",
  WoodDark: "#77563C",
};

/** Plain names for the palette, so `--colour green` works. */
const PLAIN: Readonly<Record<string, string>> = {
  white: "None", grey: "SilverSand", gray: "SilverSand", darkgrey: "DoveGray", darkgray: "DoveGray",
  aqua: "AquamarineDark", blue: "CornflowerDark", navy: "CornflowerDark", orange: "Carrot", red: "Coral",
  lime: "MeadowLight", green: "Meadow", sage: "Avocado", teal: "Petrol", darkteal: "PetrolDark",
  brown: "Wood", darkbrown: "WoodDark",
};

/** KNIME's default border colour for a new annotation. */
export const DEFAULT_COLOUR = PALETTE.SilverSand!;

const fold = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");

/** A palette name (`meadow`, `green`, `silver-sand`) or hex (`#3CB44B`, `3cb44b`, `#3c4`) as `#RRGGBB`. */
export function parseColour(text: string): string {
  const t = text.trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t)?.[1];
  if (hex) return `#${(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toUpperCase()}`;
  const key = fold(t);
  const name = Object.keys(PALETTE).find((n) => fold(n) === key) ?? PLAIN[key];
  if (name) return PALETTE[name]!;
  throw new CliError({
    code: "BAD_COLOUR", exit: EXIT.USAGE, message: `"${text}" is neither a hex colour nor a palette name`,
    hint: `Use #RRGGBB, or one of: ${Object.keys(PALETTE).join(", ")} (also ${Object.keys(PLAIN).join(", ")}).`,
  });
}

/** The palette name of a colour, if it has one. */
export function colourName(hex: string | undefined): string | undefined {
  if (!hex) return undefined;
  return Object.entries(PALETTE).find(([, v]) => v.toLowerCase() === hex.toLowerCase())?.[0];
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** `x,y,w,h` in workflow coordinates. */
export function parseBounds(text: string): Bounds {
  const parts = text.split(",").map((p) => p.trim());
  const nums = parts.map(Number);
  if (parts.length !== 4 || !nums.every(Number.isInteger) || nums[2]! <= 0 || nums[3]! <= 0) {
    throw usage(`Bounds must be x,y,width,height (integers, positive size), got "${text}"`);
  }
  const [x, y, width, height] = nums as [number, number, number, number];
  return { x, y, width, height };
}

export const sameBounds = (a: Bounds | undefined, b: Bounds | undefined) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Canvas geometry, from the KNIME UI: a node's position is the top-left of its 32 px icon. */
const NODE_SIZE = 32;
/** Room for the node name above the icon, which is centred and wider than it. */
const PAD_SIDE = 60;
const PAD_TOP = 50;
/** The annotation's own text sits at its top-left, above the nodes. */
const TEXT_LINE = 20;
/** The node label (and note) below the icon. */
const PAD_BOTTOM = 30;
const LABEL_LINE = 16;

/** A box around the nodes' icons, padded for their names and labels, with room at the top for `textLines`. */
export function boundsAround(nodes: readonly Pick<NodeView, "id" | "position" | "label" | "note">[], textLines: number): Bounds {
  const placed = nodes.filter((n) => n.position);
  if (!placed.length) throw usage(`None of ${nodes.map((n) => n.id).join(", ") || "the nodes"} has a canvas position`);
  const xs = placed.map((n) => n.position!.x);
  const ys = placed.map((n) => n.position!.y);
  const labelLines = Math.max(1, ...placed.map((n) => (n.label ? 1 : 0) + (n.note?.split("\n").length ?? 0)));
  const x = Math.min(...xs) - PAD_SIDE;
  const y = Math.min(...ys) - PAD_TOP - TEXT_LINE * Math.max(0, textLines);
  const right = Math.max(...xs) + NODE_SIZE + PAD_SIDE;
  const bottom = Math.max(...ys) + NODE_SIZE + PAD_BOTTOM + LABEL_LINE * labelLines;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) };
}

// ---------------------------------------------------------------------------------------------------------------
// Tags

const TAG_LINE = /\[\[([^\[\]\n]+)\]\]\s*$/;

/** A tag is one line, no brackets. */
export function checkTag(tag: string): string {
  const t = tag.trim();
  if (!t || /[\[\]\n]/.test(t)) throw usage(`Bad tag "${tag}": one line, no square brackets`);
  return t;
}

/** Annotation HTML from plain text (or raw HTML) plus an optional tag paragraph. */
export function composeHtml(body: { text?: string; html?: string }, tag?: string): string {
  const main = body.html ?? (body.text ? textToHtml(body.text) : "");
  return tag ? `${main}<p>[[${tag}]]</p>` : main;
}

export interface AnnotationView {
  id: string;
  /** The `[[tag]]` the CLI wrote as the last line, if any. */
  tag?: string;
  /** Plain text without the tag line. */
  text: string;
  /** The stored HTML (or plain text, in old workflows), as is. */
  raw: string;
  contentType: string;
  bounds: Bounds;
  colour?: string;
  colourName?: string;
}

export function readAnnotation(a: WorkflowAnnotationEnt): AnnotationView {
  const raw = a.text?.value ?? "";
  const contentType = a.text?.contentType ?? "text/plain";
  const plain = contentType === "text/html" ? htmlToText(raw) : raw;
  const m = TAG_LINE.exec(plain);
  const text = (m ? plain.slice(0, m.index) : plain).replace(/\s+$/, "");
  return {
    id: a.id, tag: m?.[1]?.trim(), text, raw, contentType,
    bounds: a.bounds, colour: a.borderColor, colourName: colourName(a.borderColor),
  };
}

/** The body HTML of an annotation without its tag paragraph, so a retag or recolour keeps the text as written. */
export function bodyHtml(a: AnnotationView): string {
  if (a.contentType !== "text/html") return textToHtml(a.text);
  return a.tag ? a.raw.replace(/<p>\s*\[\[[^\[\]]*\]\]\s*<\/p>\s*$/i, "") : a.raw;
}

/** How many lines the annotation's text takes, tag included: the room `boundsAround` leaves at the top. */
export function textLines(text: string | undefined, tag: string | undefined): number {
  return (text ? text.split("\n").length : 0) + (tag ? 1 : 0);
}
