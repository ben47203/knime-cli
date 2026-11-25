import { listInstances } from "../../src/discovery.ts";
import { seconds, type Command } from "../cli.ts";
import { CliError, EXIT, translate } from "../errors.ts";
import { EXPECTED_API_VERSION } from "../session.ts";
import type { Status } from "../types.ts";

export const status: Command = {
  path: ["status"],
  tier: "READ",
  summary: "Which KNIME instance the CLI talks to, whether it's ready, and its API version",
  options: {
    wait: { type: "string", arg: "<seconds>", desc: "Poll until KNIME's UI is ready, up to this long" },
  },
  notes: [
    "Instances come from ~/.knime-cli/instances/<pid>.json; files of dead processes are removed. The newest live",
    "instance wins unless --pid or KNIME_CLI_PID picks one. Exits 4 if no instance is found or it isn't ready.",
  ],
  examples: ["knime status", "knime status --wait 60 --json"],
  async run(ctx) {
    const s = await ctx.session();
    const waitMs = seconds(ctx, "wait", 0);
    const deadline = Date.now() + waitMs;
    let st: Status;
    for (;;) {
      try {
        st = await s.transport.status();
      } catch (e) {
        throw translate(e, "status");
      }
      if (st.ready || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const others = (await listInstances()).filter((i) => i.pid !== s.instance?.pid).map((i) => i.pid);
    if (st.apiVersion !== EXPECTED_API_VERSION) ctx.warn(`plugin API v${st.apiVersion}; this CLI was written for v${EXPECTED_API_VERSION}`);
    const data = {
      pid: st.pid, url: s.instance?.url, ready: st.ready, apiVersion: st.apiVersion, expectedApiVersion: EXPECTED_API_VERSION,
      knimeVersion: st.knimeVersion, startedAt: s.instance?.startedAt, otherInstances: others,
    };
    if (!st.ready) {
      throw new CliError({
        code: "NOT_READY", exit: EXIT.UNAVAILABLE, message: `KNIME pid ${st.pid} is running but its UI isn't ready yet`,
        hint: "Retry in a few seconds, or `knime status --wait 60`.", details: data,
      });
    }
    return {
      data,
      text: [
        `KNIME ${st.knimeVersion}, pid ${st.pid}, ${st.ready ? "ready" : "NOT ready"}`,
        `API v${st.apiVersion} at ${s.instance?.url ?? "?"} (started ${s.instance?.startedAt ?? "?"})`,
        ...(others.length ? [`other live instances: ${others.join(", ")} (pick with --pid)`] : []),
      ],
    };
  },
};
