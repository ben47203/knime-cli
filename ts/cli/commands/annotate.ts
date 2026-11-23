import {
  bodyHtml, boundsAround, checkTag, composeHtml, DEFAULT_COLOUR, formatBounds, PALETTE, parseBounds, parseColour, sameBounds,
  textLines, type AnnotationView, type Bounds,
} from "../annotations.ts";
import { arg, str, type Command, type Ctx, type OptionSpec } from "../cli.ts";
import { CliError, EXIT, usage } from "../errors.ts";
import type { NodeView, Snapshot } from "../session.ts";
import { htmlToText } from "../text.ts";

const ORDER = { front: "bring_to_front", back: "send_to_back", forward: "bring_forward", backward: "send_backward" } as const;

const PLACEMENT: Record<string, OptionSpec> = {
  bounds: { type: "string", arg: "<x,y,w,h>", desc: "Explicit position and size, in workflow coordinates" },
  around: { type: "string", multiple: true, arg: "<node[,node…]>", desc: "Fit a padded box around these nodes (ids or labels; repeatable)" },
  prefix: { type: "string", arg: "<label-prefix>", desc: "Fit the box around every node whose label starts with this" },
};

const TEXT: Record<string, OptionSpec> = {
  text: { type: "string", arg: "<text>", desc: "Plain text; \\n starts a new line (stored as HTML paragraphs)" },
  html: { type: "string", arg: "<html>", desc: "Raw HTML instead of --text, as the KNIME editor writes it (<p>, <b>, <ul>…)" },
  colour: { type: "string", arg: "<hex|name>", desc: `Border colour: #RRGGBB or a palette name (default SilverSand)` },
};

const PALETTE_NOTE = `Palette (KNIME's own): ${Object.keys(PALETTE).join(", ")}; also white, grey, blue, orange, red, green, teal, brown….`;

function describe(a: AnnotationView): string {
  return `${a.id}${a.tag ? ` [[${a.tag}]]` : ""}`;
}

function firstLine(t: string, max = 60): string {
  const l = t.split("\n").find((x) => x.trim()) ?? "";
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

function textOption(ctx: Ctx): { text?: string; html?: string } | undefined {
  const text = str(ctx, "text");
  const html = str(ctx, "html");
  if (text !== undefined && html !== undefined) throw usage("Give --text or --html, not both");
  if (text !== undefined) return { text: text.replace(/\\n/g, "\n") };
  if (html !== undefined) return { html };
  return undefined;
}

/** The nodes named by --around (comma-separated or repeated) and --prefix, or undefined if neither was given. */
function aroundNodes(ctx: Ctx, snap: Snapshot): NodeView[] | undefined {
  const refs = ((ctx.values.around as string[] | undefined) ?? []).flatMap((a) => a.split(",")).map((r) => r.trim()).filter(Boolean);
  const prefix = str(ctx, "prefix");
  if (!refs.length && prefix === undefined) return undefined;
  const nodes = [...refs.map((r) => snap.resolve(r)), ...(prefix !== undefined ? snap.withPrefix(prefix) : [])];
  if (!nodes.length) {
    throw new CliError({
      code: "NODE_NOT_FOUND", exit: EXIT.NOT_FOUND, message: `No nodes labelled ${prefix}*`,
      hint: "Run `knime workflow show` for the labels, or name nodes with --around.",
    });
  }
  return [...new Map(nodes.map((n) => [n.id, n])).values()];
}

function placement(ctx: Ctx, snap: Snapshot, lines: number): { bounds: Bounds; around?: string[] } | undefined {
  const explicit = str(ctx, "bounds");
  const nodes = aroundNodes(ctx, snap);
  if (explicit && nodes) throw usage("Give --bounds or --around/--prefix, not both");
  if (explicit) return { bounds: parseBounds(explicit) };
  if (nodes) return { bounds: boundsAround(nodes, lines), around: nodes.map((n) => n.id) };
  return undefined;
}

export const annotateAdd: Command = {
  path: ["annotate", "add"],
  tier: "WRITE",
  summary: "Add a coloured workflow annotation, placed by --bounds or fitted --around nodes; prints its id",
  options: {
    ...TEXT,
    tag: { type: "string", arg: "<tag>", desc: "Tag to find it again by (recommended: your prefix, e.g. my:prep); shown as [[tag]]" },
    ...PLACEMENT,
  },
  notes: [
    "--around fits a box round the nodes' icons, padded for their names and labels, with room at the top for",
    "the text: the way to group a pipeline stage visually. Annotations sit behind nodes.",
    "The tag is written as a last paragraph, [[tag]], so it survives edits in the KNIME UI. Ids (root_3) are",
    "reused after deletes, so address your annotations by tag; `annotate rm` refuses untagged ones without --force.",
    PALETTE_NOTE,
    "Undoable in KNIME (one command for the box, one for the text).",
  ],
  examples: [
    "knime annotate add --text \"Data prep\" --colour meadow --tag my:prep --prefix my:prep-",
    "knime annotate add --text \"Models\" --around my:rf,my:gbt --colour Carrot --tag my:models",
    "knime annotate add --text \"TODO\" --bounds 100,400,300,120 --tag my:todo --json",
  ],
  async run(ctx) {
    const body = textOption(ctx);
    const tagText = str(ctx, "tag");
    const tag = tagText === undefined ? undefined : checkTag(tagText);
    const borderColor = str(ctx, "colour") ? parseColour(str(ctx, "colour")!) : DEFAULT_COLOUR;
    const s = await ctx.session();
    const snap = await s.snapshot();
    const lines = textLines(body?.text ?? (body?.html !== undefined ? htmlToText(body.html) : undefined), tag);
    const placed = placement(ctx, snap, lines);
    if (!placed) throw usage("Place the annotation with --bounds x,y,w,h or --around <nodes> / --prefix <label-prefix>");
    if (tag && snap.annotations.some((a) => a.tag === tag)) ctx.warn(`tag "${tag}" is already on ${snap.annotations.filter((a) => a.tag === tag).map((a) => a.id).join(", ")}`);
    const r = await s.command<{ newAnnotationId?: string }>({ kind: "add_workflow_annotation", bounds: placed.bounds, borderColor }, "add annotation");
    const id = r?.newAnnotationId;
    if (!id) throw new CliError({ code: "ERROR", exit: EXIT.ERROR, message: `add_workflow_annotation returned no id: ${JSON.stringify(r)}` });
    const html = composeHtml(body ?? {}, tag);
    if (html) {
      try {
        await s.command({ kind: "update_workflow_annotation", annotationId: id, text: html }, `text of ${id}`);
      } catch (e) {
        // Don't leave an empty, untagged box behind.
        await s.command({ kind: "delete", nodeIds: [], annotationIds: [id], connectionIds: [] }, `remove ${id}`).catch(() => {});
        throw e;
      }
    }
    if (!tag) ctx.warn("no --tag: tag your annotations so later runs can find them (ids are reused after deletes)");
    return {
      data: { id, tag, bounds: placed.bounds, colour: borderColor, around: placed.around },
      text: [`added ${id}${tag ? ` [[${tag}]]` : ""} at ${formatBounds(placed.bounds)}`],
    };
  },
};

export const annotateList: Command = {
  path: ["annotate", "list"],
  tier: "READ",
  summary: "Workflow annotations: id, tag, colour, bounds and text (back to front)",
  options: {
    prefix: { type: "string", arg: "<tag-prefix>", desc: "Only annotations whose tag starts with this" },
  },
  notes: ["Ids are root_<n> (or <metanode>_<n> with --workflow) and are reused after deletes; tags are [[…]] lines the CLI wrote."],
  examples: ["knime annotate list", "knime annotate list --prefix my: --json"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const prefix = str(ctx, "prefix");
    const list = prefix !== undefined ? snap.annotationsWithPrefix(prefix) : snap.annotations;
    const data = list.map((a) => ({ id: a.id, tag: a.tag, text: a.text, colour: a.colour, colourName: a.colourName, bounds: a.bounds, contentType: a.contentType }));
    const w = { id: Math.max(2, ...list.map((a) => a.id.length)), tag: Math.max(3, ...list.map((a) => (a.tag ?? "").length)) };
    return {
      data: { annotations: data },
      text: list.length
        ? [
          `${"id".padEnd(w.id)}  ${"tag".padEnd(w.tag)}  ${"colour".padEnd(14)}  ${"x,y,w,h".padEnd(19)}  text`,
          ...list.map((a) => `${a.id.padEnd(w.id)}  ${(a.tag ?? "").padEnd(w.tag)}  ${(a.colourName ?? a.colour ?? "").padEnd(14)}  ${formatBounds(a.bounds).padEnd(19)}  ${firstLine(a.text)}`),
        ]
        : [prefix !== undefined ? `no annotations tagged ${prefix}*` : "no annotations"],
    };
  },
};

export const annotateUpdate: Command = {
  path: ["annotate", "update"],
  tier: "WRITE",
  summary: "Change an annotation's text, colour or tag (by id or tag)",
  args: "<id|tag>",
  options: {
    ...TEXT,
    tag: { type: "string", arg: "<tag>", desc: "Retag it (or tag an untagged one)" },
    untag: { type: "boolean", desc: "Remove its tag line" },
  },
  notes: [
    "Unchanged parts are kept: --colour alone keeps the text, --text keeps the tag. Fields that already match send",
    "nothing. Undoable in KNIME.",
    PALETTE_NOTE,
  ],
  examples: ["knime annotate update my:prep --text \"Data prep\\nclean and split\"", "knime annotate update root_2 --colour coral --tag my:todo"],
  async run(ctx) {
    const body = textOption(ctx);
    const tagText = str(ctx, "tag");
    if (tagText !== undefined && ctx.values.untag) throw usage("Give --tag or --untag, not both");
    const colour = str(ctx, "colour") ? parseColour(str(ctx, "colour")!) : undefined;
    if (!body && tagText === undefined && !ctx.values.untag && !colour) throw usage("Nothing to change: give --text, --html, --colour, --tag or --untag");
    const s = await ctx.session();
    const snap = await s.snapshot();
    const a = snap.resolveAnnotation(arg(ctx, 0, "annotation id or tag"));
    const tag = ctx.values.untag ? undefined : tagText !== undefined ? checkTag(tagText) : a.tag;
    const html = composeHtml(body ?? { html: bodyHtml(a) }, tag);
    // Any update makes KNIME store HTML, so an old plain-text annotation gets its text converted too.
    const sendText = html !== a.raw || a.contentType !== "text/html";
    const sendColour = colour !== undefined && colour.toLowerCase() !== a.colour?.toLowerCase();
    if (!sendText && !sendColour) return { data: { id: a.id, tag, changed: false }, text: [`${describe(a)}: unchanged`] };
    await s.command({
      kind: "update_workflow_annotation", annotationId: a.id,
      ...(sendText ? { text: html } : {}), ...(sendColour ? { borderColor: colour } : {}),
    }, `update ${a.id}`);
    return {
      data: { id: a.id, tag, previousTag: a.tag, changed: true, text: sendText, colour: sendColour ? colour : undefined },
      text: [`updated ${a.id}${tag ? ` [[${tag}]]` : ""}: ${[sendText && "text", sendColour && "colour"].filter(Boolean).join(", ")}`],
    };
  },
};

export const annotateMove: Command = {
  path: ["annotate", "move"],
  tier: "WRITE",
  summary: "Move or resize an annotation (--bounds, --around, --by), or change its stacking (--order)",
  args: "<id|tag>",
  options: {
    ...PLACEMENT,
    by: { type: "string", arg: "<dx,dy>", desc: "Shift by this much, keeping the size" },
    order: { type: "string", arg: "<front|back|forward|backward>", desc: "Bring to front, send to back, or one step" },
  },
  notes: [
    "--around re-fits the box, e.g. after adding nodes to a stage. A value starting with a minus needs `=`:",
    "--by=-300,0, --bounds=-50,0,200,100. Undoable in KNIME.",
  ],
  examples: ["knime annotate move my:prep --prefix my:prep-", "knime annotate move root_0 --by=-200,0", "knime annotate move my:models --order back"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const a = snap.resolveAnnotation(arg(ctx, 0, "annotation id or tag"));
    const by = str(ctx, "by");
    const order = str(ctx, "order");
    if (order !== undefined && !(order in ORDER)) throw usage(`--order must be one of ${Object.keys(ORDER).join(", ")}`);
    let target = placement(ctx, snap, textLines(a.text, a.tag));
    if (by) {
      if (target) throw usage("Give --by or --bounds/--around, not both");
      const m = /^(-?\d+),(-?\d+)$/.exec(by);
      if (!m) throw usage("--by must be dx,dy (integers)");
      target = { bounds: { ...a.bounds, x: a.bounds.x + Number(m[1]), y: a.bounds.y + Number(m[2]) } };
    }
    if (!target && !order) throw usage("Give --bounds, --around/--prefix, --by or --order");
    const moved = target && !sameBounds(target.bounds, a.bounds);
    if (moved) await s.command({ kind: "transform_workflow_annotation", annotationId: a.id, bounds: target!.bounds }, `move ${a.id}`);
    if (order) {
      await s.command({ kind: "reorder_workflow_annotations", annotationIds: [a.id], action: ORDER[order as keyof typeof ORDER] }, `reorder ${a.id}`);
    }
    const bounds = target?.bounds ?? a.bounds;
    return {
      data: { id: a.id, tag: a.tag, bounds, previous: a.bounds, moved: Boolean(moved), order, around: target?.around },
      text: [`${describe(a)}: ${[moved ? `at ${formatBounds(bounds)}` : target ? "already in place" : "", order ? `order ${order}` : ""].filter(Boolean).join(", ")}`],
    };
  },
};

export const annotateRm: Command = {
  path: ["annotate", "rm"],
  tier: "WRITE",
  summary: "Delete annotations by id/tag, or every annotation whose tag starts with --prefix",
  args: "[id|tag…]",
  options: {
    prefix: { type: "string", arg: "<tag-prefix>", desc: "Delete every annotation whose tag starts with this (at least 2 characters)" },
    force: { type: "boolean", desc: "Allow deleting untagged annotations" },
    "dry-run": { type: "boolean", desc: "Only list what would be deleted" },
  },
  notes: ["Refuses (exit 9) to delete untagged annotations without --force: they may be someone else's. Undoable in KNIME."],
  examples: ["knime annotate rm my:prep", "knime annotate rm --prefix my: --dry-run"],
  async run(ctx) {
    const s = await ctx.session();
    const snap = await s.snapshot();
    const prefix = str(ctx, "prefix");
    if (prefix !== undefined && prefix.length < 2) {
      throw new CliError({ code: "REFUSED", exit: EXIT.REFUSED, message: "--prefix must be at least 2 characters", hint: "Use your own tag prefix, e.g. my:" });
    }
    const found = [...(prefix ? snap.annotationsWithPrefix(prefix) : []), ...ctx.positionals.map((p) => snap.resolveAnnotation(p))];
    const unique = [...new Map(found.map((a) => [a.id, a])).values()];
    if (!unique.length) {
      if (!prefix) throw usage("Name the annotations to delete, or pass --prefix");
      return { data: { deleted: [] }, text: [`no annotations tagged ${prefix}*`] };
    }
    const untagged = unique.filter((a) => !a.tag);
    if (untagged.length && !ctx.values.force) {
      throw new CliError({
        code: "REFUSED", exit: EXIT.REFUSED,
        message: `Refusing to delete untagged annotation(s): ${untagged.map((a) => `${a.id} "${firstLine(a.text, 40)}"`).join(", ")}`,
        hint: "They may not be yours. Tag them first (`knime annotate update <id> --tag …`), or pass --force if you're sure.",
      });
    }
    const list = unique.map((a) => ({ id: a.id, tag: a.tag, text: firstLine(a.text) }));
    if (ctx.values["dry-run"]) return { data: { wouldDelete: list }, text: ["would delete:", ...unique.map((a) => `  ${describe(a)} ${firstLine(a.text)}`)] };
    await s.command({ kind: "delete", nodeIds: [], annotationIds: unique.map((a) => a.id), connectionIds: [] }, `delete ${unique.length} annotation(s)`);
    return { data: { deleted: list }, text: [`deleted ${unique.length} annotation(s):`, ...unique.map((a) => `  ${describe(a)} ${firstLine(a.text)}`)] };
  },
};
