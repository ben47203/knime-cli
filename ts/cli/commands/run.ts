import { seconds, type Command } from "../cli.ts";
import { EXIT } from "../errors.ts";
import { formatReport, runNodes } from "../execute.ts";

export const run: Command = {
  path: ["run"],
  tier: "EXEC",
  summary: "Execute nodes (and what they need upstream), wait past the 30 s cap, and fail if any didn't run",
  args: "[nodes…]",
  options: {
    timeout: { type: "string", arg: "<seconds>", desc: "Give up waiting after this long (default 600); nodes keep running" },
  },
  notes: [
    "Without nodes, executes the whole workflow. Afterwards it checks every node in scope (the targets and their",
    "upstream) and exits 8 listing nodes that aren't EXECUTED, because the server can report success for nodes",
    "that stayed IDLE. Running it again while nodes execute just keeps waiting.",
  ],
  examples: ["knime run my:scorer", "knime run root:3 root:9 --timeout 1200 --json"],
  async run(ctx) {
    const s = await ctx.session();
    let nodeIds: string[] | undefined;
    if (ctx.positionals.length) {
      const snap = await s.snapshot();
      nodeIds = ctx.positionals.map((p) => snap.resolve(p).id);
    } else {
      ctx.warn("no nodes given: executing the whole workflow");
    }
    const report = await runNodes(s, nodeIds, { timeoutMs: seconds(ctx, "timeout", 600) });
    const code = report.ok ? "OK" : report.done ? "NOT_EXECUTED" : "TIMEOUT";
    return {
      data: { code, targets: nodeIds ?? "all", ...report },
      text: formatReport(report),
      exit: report.ok ? EXIT.OK : EXIT.INCOMPLETE,
    };
  },
};
