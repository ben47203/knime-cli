import { readFile } from "node:fs/promises";

import { apply as applySpec, formatPlan, planApply, resolveSpec } from "../apply.ts";
import { arg, seconds, type Command } from "../cli.ts";
import { EXIT, usage } from "../errors.ts";
import { formatReport } from "../execute.ts";

export const apply: Command = {
  path: ["apply"],
  tier: "EXEC",
  summary: "Build a pipeline from a JSON spec, idempotently by label: add, connect, run upstream, patch, run",
  args: "<pipeline.json>",
  options: {
    "dry-run": { type: "boolean", desc: "Show the structural plan; touch nothing" },
    rebuild: { type: "boolean", desc: "Remove and re-add every node with the prefix" },
    "no-run": { type: "boolean", desc: "Build and configure, but don't run the final nodes" },
    timeout: { type: "string", arg: "<seconds>", desc: "Per execution step (default 600)" },
  },
  notes: [
    "Only nodes labelled <prefix>… are reused or removed; nothing else is touched, and the project isn't saved.",
    "Settings changes reset downstream nodes and can't be undone. Safe to re-run after a failure or a 504.",
    "Spec format and behaviour: `knime guide apply`. Example: cli/examples/housing-small.json.",
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
    const spec = resolveSpec(raw);
    const s = await ctx.session();
    if (ctx.values["dry-run"]) {
      const plan = planApply(spec, await s.snapshot(), { rebuild: Boolean(ctx.values.rebuild) });
      return { data: { dryRun: true, plan }, text: ["plan (dry run; settings are diffed only when applied):", ...formatPlan(plan)] };
    }
    const r = await applySpec(s, spec, {
      rebuild: Boolean(ctx.values.rebuild), noRun: Boolean(ctx.values["no-run"]), timeoutMs: seconds(ctx, "timeout", 600), log: ctx.log,
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
