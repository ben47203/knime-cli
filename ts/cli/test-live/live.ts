/**
 * Shared helpers of the live end-to-end suite: every command runs through `main` in-process against the running
 * KNIME (KNIME_CLI_PID, else the newest live instance), exactly as `knime` would. Suites skip when no KNIME answers.
 *
 * Every node the suite makes is labelled with the `e2e:` prefix and removed afterwards, even on failure. Other
 * agents may share the canvas, so nothing else is touched.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KnimeClient } from "../../src/client.ts";
import { listInstances } from "../../src/discovery.ts";
import { main, type Io } from "../cli.ts";
import { COMMANDS } from "../commands/index.ts";
import { Session } from "../session.ts";

export const PREFIX = "e2e:";

/** False when a ready KNIME answers, else why the suite is skipped. */
export async function skipReason(): Promise<string | false> {
  const wanted = process.env.KNIME_CLI_PID;
  const all = await listInstances();
  const inst = wanted ? all.find((i) => String(i.pid) === wanted) : all[0];
  if (!inst) return wanted ? `no live KNIME with pid ${wanted}` : "no KNIME running (set KNIME_CLI_PID)";
  try {
    const st = await new KnimeClient(inst).status();
    return st.ready ? false : `KNIME pid ${inst.pid} isn't ready`;
  } catch (e) {
    return `KNIME pid ${inst.pid} doesn't answer: ${(e as Error).message}`;
  }
}

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The parsed `--json` document (added unless `human` is set). */
  json: {
    ok: boolean; command?: string; notes: string[]; warnings: string[]; dirty?: boolean | null;
    data?: any; error?: { code: string; message: string; cause?: string; hint?: string; details?: unknown };
  };
}

/** `knime …argv --json`, in-process. */
export async function knime(...argv: string[]): Promise<Run> {
  return invoke([...argv, "--json"]);
}

/** `knime …argv` with human output. */
export async function human(...argv: string[]): Promise<Omit<Run, "json">> {
  const { json: _, ...rest } = await invoke(argv);
  return rest;
}

async function invoke(argv: string[]): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), connect: (o) => Session.connect(o) };
  const code = await main(COMMANDS, argv, io);
  let json = undefined as unknown as Run["json"];
  if (argv.includes("--json")) {
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new Error(`knime ${argv.join(" ")}: stdout isn't JSON:\n${stdout}\n${stderr}`);
    }
  }
  return { code, stdout, stderr, json };
}

/** Removes every node labelled with `prefix` (default: the whole e2e: prefix). Never throws. */
export async function cleanup(prefix = PREFIX): Promise<void> {
  try {
    const r = await knime("node", "rm", "--prefix", prefix);
    if (r.code !== 0) console.error(`cleanup of ${prefix}* failed: ${JSON.stringify(r.json.error)}`);
  } catch (e) {
    console.error(`cleanup of ${prefix}* failed: ${(e as Error).message}`);
  }
}

/** A directory for the suite's files: E2E_DIR if set, else a fresh one under the OS temp folder. */
export async function workDir(name: string): Promise<string> {
  if (process.env.E2E_DIR) {
    const dir = join(process.env.E2E_DIR, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }
  return mkdtemp(join(tmpdir(), `knime-cli-e2e-${name}-`));
}

/** A small CSV: three cities with sales. */
export const SALES_CSV = "city,sales\nPerth,13\nHobart,7\nDarwin,4\n";

export const unsaved = (r: Run) => r.json.warnings.some((w) => /has unsaved changes; `knime save` saves them/.test(w));
export const alreadyDirty = (r: Run) => r.json.warnings.some((w) => /already had unsaved changes/.test(w));
