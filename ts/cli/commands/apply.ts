import { readFile } from "node:fs/promises";

import { apply as applySpec, formatPlan, planApply, resolveSpec } from "../apply.ts";
import { arg, seconds, str, warnIfDirtyBeforeReset, type Command } from "../cli.ts";
import { EXIT, usage } from "../errors.ts";
import { formatReport } from "../execute.ts";

export const apply: Command = {
  path: ["apply"],
  tier: "EXEC",
  summary: "Build a pipeline from a JSON spec, idempotently by label: add, connect, run upstream, patch, run",
  args: "<pipeline.json>",
  options: {
    prefix: { type: "string", arg: "<label-prefix>", desc: "Use this label prefix instead of the spec's (e.g. to build a second copy)" },
    "dry-run": { type: "boolean", desc: "Show the structural plan; touch nothing" },
    rebuild: { type: "boolean", desc: "Remove and re-add every node with the prefix" },
    "no-run": { type: "boolean", desc: "Build and configure, but don't run the final nodes" },
    timeout: { type: "string", arg: "<seconds>", desc: "Per execution step (default 600)" },
  },
  notes: [
    "Only nodes labelled <prefix>… are reused or removed; nothing else is touched. The project isn't saved: `knime save`.",
    "Settings changes reset downstream nodes and can't be undone. Safe to re-run after a failure or a 504.",
    "Spec format and behaviour: `knime guide apply`. Example: cli/examples/housing-small.json.",
    "Settings may pick columns from upstream specs: {\"$columns\": {\"from\": \"missing:1\", \"type\": \"number\", \"exclude\": [\"y\"]}}.",
  ],
  examples: ["knime apply cli/examples/housing-small.json --dry-run", "HOUSING_CSV=/data/housing.csv knime apply cli/examples/housing-small.json --json"],
  async run(ctx) {
    const file = arg(ctx, 0, "pipeline spec file");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      throw usage(`Can't read ${file}: ${(e as Error).message}`);
    }
    const prefix = str(ctx, "prefix");
    if (prefix !== undefined && raw && typeof raw === "object") (raw as { prefix?: string }).prefix = prefix;
    const spec = resolveSpec(raw);
    const s = await ctx.session();
    if (ctx.values["dry-run"]) {
      const plan = planApply(spec, await s.snapshot(), { rebuild: Boolean(ctx.values.rebuild) });
      return { data: { dryRun: true, plan }, text: ["plan (dry run; settings are diffed only when applied):", ...formatPlan(plan)] };
    }
    const r = await applySpec(s, spec, {
      rebuild: Boolean(ctx.values.rebuild), noRun: Boolean(ctx.values["no-run"]), timeoutMs: seconds(ctx, "timeout", 600), log: ctx.log,
      onStart: (snap) => warnIfDirtyBeforeReset(ctx, snap.dirty),
    });
    for (const w of r.warnings) ctx.warn(w);
    const ok = !r.run || r.run.ok;
    return {
      data: { ...r, ok },
      text: [
        ...formatPlan(r.plan),
        `settings: ${r.patched.filter((p) => p.changed).length} node(s) changed, ${r.patched.filter((p) => !p.changed).length} already matched`,
        ...(r.run ? formatReport(r.run) : ["not run (--no-run)"]),
      ],
      exit: ok ? EXIT.OK : EXIT.INCOMPLETE,
    };
  },
};
