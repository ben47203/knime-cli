/**
 * The command framework: a registry of commands with tiers, argument parsing on node:util parseArgs, help text, and
 * the output contract (human text, or one JSON document on stdout with `--json`).
 */
import { parseArgs, type ParseArgsConfig } from "node:util";

import { CliError, EXIT, translate, usage } from "./errors.ts";
import { Session, type SessionOptions } from "./session.ts";

/** READ changes nothing; WRITE changes the workflow; EXEC runs nodes. LOCAL needs no KNIME. */
export type Tier = "LOCAL" | "READ" | "WRITE" | "EXEC";

export interface OptionSpec {
  type: "string" | "boolean";
  short?: string;
  multiple?: boolean;
  desc: string;
  /** Shown in help, e.g. "<seconds>". */
  arg?: string;
}

export interface Output {
  data: unknown;
  text?: string[];
  exit?: number;
}

export interface Ctx {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
  json: boolean;
  session(): Promise<Session>;
  warn(message: string): void;
  /** Progress lines; stderr, and only in human mode. */
  log(message: string): void;
}

export interface Command {
  path: string[];
  tier: Tier;
  summary: string;
  /** Arguments after the command path, e.g. "<node> <path=value>…". */
  args?: string;
  /** Extra help paragraphs. */
  notes?: string[];
  examples?: string[];
  options?: Record<string, OptionSpec>;
  run(ctx: Ctx): Promise<Output>;
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: "boolean", desc: "Print one JSON document on stdout (errors too): {ok, data, warnings, notes} or {ok: false, error}" },
  pid: { type: "string", arg: "<pid>", desc: "KNIME instance to use (default: KNIME_CLI_PID, else the newest live one)" },
  project: { type: "string", arg: "<id|name>", desc: "Open project to use (default: KNIME_CLI_PROJECT, else the first open one)" },
  workflow: { type: "string", arg: "<id>", desc: "Workflow inside the project: root (default) or a metanode/component id" },
  help: { type: "boolean", short: "h", desc: "Show help" },
};

const TIER_NOTE: Record<Tier, string> = {
  LOCAL: "LOCAL: needs no KNIME",
  READ: "READ: changes nothing",
  WRITE: "WRITE: changes the workflow",
  EXEC: "EXEC: runs nodes",
};

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  connect(options: SessionOptions): Promise<Session>;
}

export const defaultIo: Io = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  connect: (o) => Session.connect(o),
};

/** Longest command path matching the leading words of argv, skipping global options before it. */
export function findCommand(commands: readonly Command[], argv: readonly string[]): { command?: Command; rest: string[] } {
  const words: number[] = [];
  for (let i = 0; i < argv.length && words.length < 3; i++) {
    const a = argv[i]!;
    if (a.startsWith("-")) {
      const name = a.replace(/^--?/, "").split("=")[0]!;
      if (GLOBAL_OPTIONS[name]?.type === "string" && !a.includes("=")) i++;
      if (words.length) break;
      continue;
    }
    words.push(i);
  }
  for (let n = words.length; n > 0; n--) {
    const path = words.slice(0, n).map((i) => argv[i]!);
    const command = commands.find((c) => c.path.length === n && c.path.every((p, j) => p === path[j]));
    if (command) {
      const drop = new Set(words.slice(0, n));
      return { command, rest: argv.filter((_, i) => !drop.has(i)) };
    }
  }
  return { rest: [...argv] };
}

function parseConfig(options: Record<string, OptionSpec>): ParseArgsConfig["options"] {
  return Object.fromEntries(Object.entries(options).map(([k, o]) => [k, {
    type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}),
  }]));
}

export function helpFor(c: Command): string {
  const lines = [`knime ${c.path.join(" ")}${c.args ? ` ${c.args}` : ""}`, "", `${c.summary}`, `Tier: ${TIER_NOTE[c.tier]}`];
  if (c.notes?.length) lines.push("", ...c.notes);
  const opts = { ...(c.options ?? {}), ...GLOBAL_OPTIONS };
  lines.push("", "Options:");
  for (const [k, o] of Object.entries(opts)) {
    lines.push(`  ${o.short ? `-${o.short}, ` : ""}--${k}${o.arg ? ` ${o.arg}` : ""}`.padEnd(30) + o.desc);
  }
  if (c.examples?.length) lines.push("", "Examples:", ...c.examples.map((e) => `  ${e}`));
  return lines.join("\n") + "\n";
}

export function overview(commands: readonly Command[]): string {
  const lines = [
    "knime — drive a running KNIME Analytics Platform through the knime-cli plugin's local API",
    "",
    "New here? Run `knime guide` first. Every command takes --json, and never prompts.",
    "",
    "Commands (tier: LOCAL needs no KNIME, READ changes nothing, WRITE changes the workflow, EXEC runs nodes):",
  ];
  for (const c of commands) {
    lines.push(`  ${`knime ${c.path.join(" ")}${c.args ? ` ${c.args}` : ""}`.padEnd(46)} ${`[${c.tier}]`.padEnd(8)} ${c.summary}`);
  }
  lines.push(
    "",
    "Global options: --json, --pid <pid>, --project <id|name>, --workflow <id>, -h/--help",
    "Nodes are addressed by id (root:7, or 7) or by label everywhere.",
    "Exit codes: 0 ok, 1 unexpected, 2 usage, 3 not found, 4 KNIME unavailable, 5 gateway stalled/timed out,",
    "            6 busy (409), 7 rejected by KNIME, 8 nodes didn't execute, 9 refused by a safety rule.",
  );
  return lines.join("\n") + "\n";
}

/** Runs one invocation; returns the exit code. Never throws. */
export async function main(commands: readonly Command[], argv: readonly string[], io: Io = defaultIo): Promise<number> {
  const json = argv.includes("--json");
  const warnings: string[] = [];
  let session: Session | undefined;
  let sessionOptions: SessionOptions = {};
  const notes = () => session?.notes ?? [];
  const { command, rest } = findCommand(commands, argv);
  try {
    if (!command) {
      const words = argv.filter((a) => !a.startsWith("-"));
      if (words.length === 0 || argv.includes("--help") || argv.includes("-h")) {
        if (json) io.stdout(JSON.stringify({ ok: true, data: { commands: commands.map((c) => ({ command: c.path.join(" "), args: c.args, tier: c.tier, summary: c.summary })) } }) + "\n");
        else io.stdout(overview(commands));
        return words.length === 0 && !argv.includes("--help") && !argv.includes("-h") ? EXIT.USAGE : EXIT.OK;
      }
      throw usage(`Unknown command "${words.join(" ")}"`, "Run `knime --help` for the command list.");
    }
    let parsed;
    try {
      parsed = parseArgs({ args: rest, options: parseConfig({ ...(command.options ?? {}), ...GLOBAL_OPTIONS }), allowPositionals: true, strict: true });
    } catch (e) {
      throw usage((e as Error).message, `Run \`knime ${command.path.join(" ")} --help\`.`);
    }
    const values = parsed.values as Ctx["values"];
    if (values.help) {
      if (json) io.stdout(JSON.stringify({ ok: true, data: { command: command.path.join(" "), tier: command.tier, help: helpFor(command) } }) + "\n");
      else io.stdout(helpFor(command));
      return EXIT.OK;
    }
    sessionOptions = { pid: values.pid as string | undefined, project: values.project as string | undefined, workflow: values.workflow as string | undefined };
    const ctx: Ctx = {
      values,
      positionals: parsed.positionals,
      json,
      session: async () => (session ??= await io.connect(sessionOptions)),
      warn: (m) => warnings.push(m),
      log: (m) => { if (!json) io.stderr(`${m}\n`); },
    };
    const out = await command.run(ctx);
    const exit = out.exit ?? EXIT.OK;
    if (json) {
      io.stdout(JSON.stringify({ ok: exit === EXIT.OK, command: command.path.join(" "), notes: notes(), warnings, data: out.data }, null, 2) + "\n");
    } else {
      for (const n of notes()) io.stderr(`note: ${n}\n`);
      for (const w of warnings) io.stderr(`warning: ${w}\n`);
      if (out.text?.length) io.stdout(out.text.join("\n") + "\n");
    }
    return exit;
  } catch (e) {
    const err = e instanceof CliError ? e : translate(e);
    if (json) {
      io.stdout(JSON.stringify({ ok: false, command: command?.path.join(" "), notes: notes(), warnings, error: err.toJSON() }, null, 2) + "\n");
    } else {
      for (const n of notes()) io.stderr(`note: ${n}\n`);
      for (const w of warnings) io.stderr(`warning: ${w}\n`);
      io.stderr(`error [${err.code}]: ${err.message}\n`);
      if (err.why) io.stderr(`  cause: ${err.why}\n`);
      if (err.hint) io.stderr(`  next:  ${err.hint}\n`);
      if (err.exit === EXIT.ERROR && process.env.KNIME_CLI_DEBUG && e instanceof Error) io.stderr(`${e.stack}\n`);
    }
    return err.exit;
  }
}

/** A required positional, with a usage error naming it. */
export function arg(ctx: Ctx, index: number, name: string): string {
  const v = ctx.positionals[index];
  if (v === undefined) throw usage(`Missing ${name}`);
  return v;
}

export function str(ctx: Ctx, name: string): string | undefined {
  const v = ctx.values[name];
  return typeof v === "string" ? v : undefined;
}

export function seconds(ctx: Ctx, name: string, fallback: number): number {
  const v = str(ctx, name);
  if (v === undefined) return fallback * 1000;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw usage(`--${name} must be a number of seconds`);
  return n * 1000;
}

export { CliError, EXIT };
