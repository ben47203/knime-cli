/**
 * Honest execution: execute, keep waiting past the server's 30 s cap, then check the final states ourselves, because
 * the server can report `done: true, failed: []` for nodes that stayed IDLE.
 */
import { nodeMessageHint } from "./errors.ts";
import type { Session, Snapshot } from "./session.ts";
import type { ExecResult, Message, State } from "./types.ts";

/** The server's cap on waitMs. */
export const MAX_WAIT_MS = 30_000;

export interface NodeOutcome {
  id: string;
  label?: string;
  name: string;
  state?: State;
  message?: Message;
  hint?: string;
}

export interface RunReport {
  /** Every node in scope reached EXECUTED. */
  ok: boolean;
  /** Nothing in scope is still queued or executing. */
  done: boolean;
  elapsedMs: number;
  executed: number;
  notExecuted: NodeOutcome[];
  failed: ExecResult["failed"];
}

export interface RunOptions {
  timeoutMs?: number;
  /** For tests: a clock. */
  now?: () => number;
}

/**
 * Runs `nodeIds` (and what they need upstream), or the whole workflow when undefined. `scope` for the final check is
 * the targets plus everything upstream of them.
 */
export async function runNodes(session: Session, nodeIds: string[] | undefined, opts: RunOptions = {}): Promise<RunReport> {
  const now = opts.now ?? Date.now;
  const started = now();
  const deadline = started + (opts.timeoutMs ?? 600_000);
  const waitMs = () => Math.max(0, Math.min(MAX_WAIT_MS, deadline - now()));
  const body = nodeIds ? { nodeIds } : {};
  let r = await session.api<ExecResult>("/api/execute", { ...body, waitMs: waitMs() }, "execute");
  while (!r.done && now() < deadline) {
    r = await session.api<ExecResult>("/api/wait", { ...body, waitMs: waitMs() }, "wait");
  }
  const snap = await session.snapshot();
  const scope = nodeIds ? withUpstream(snap, nodeIds) : snap.nodes.map((n) => n.id);
  const notExecuted: NodeOutcome[] = [];
  let executed = 0;
  for (const id of scope) {
    const n = snap.byId(id);
    if (!n) continue;
    if (n.state === "EXECUTED") {
      executed++;
      continue;
    }
    notExecuted.push({
      id, label: n.label, name: n.name, state: n.state, message: n.message,
      hint: nodeMessageHint(n.message?.text) ?? (n.state === "IDLE" ? "IDLE: not configured. Check its inputs and settings (`knime node settings`)." : undefined),
    });
  }
  return { ok: notExecuted.length === 0, done: r.done, elapsedMs: now() - started, executed, notExecuted, failed: r.failed };
}

export function withUpstream(snap: Snapshot, ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...snap.upstream(id));
  }
  return [...seen];
}

export function formatReport(r: RunReport): string[] {
  const lines = [`${r.executed} executed, ${r.notExecuted.length} not executed (${(r.elapsedMs / 1000).toFixed(1)} s)`];
  if (!r.done) lines.push("still running when the timeout ran out; run the same command again to keep waiting");
  for (const n of r.notExecuted) {
    lines.push(`  ✗ ${n.id}${n.label ? ` [${n.label}]` : ""} ${n.name}: ${n.state ?? "?"}${n.message ? ` — ${n.message.type}: ${n.message.text}` : ""}`);
    if (n.hint) lines.push(`      hint: ${n.hint}`);
  }
  return lines;
}
