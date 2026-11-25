import type { Command } from "../cli.ts";
import { CliError, EXIT, SAVE_BLOCKED_CAUSE, SAVE_BLOCKED_HINT } from "../errors.ts";
import type { ProjectState } from "../types.ts";

export const save: Command = {
  path: ["save"],
  tier: "WRITE",
  summary: "Save the project in place, as KNIME's Save does; the CLI never saves on its own",
  notes: [
    "Saves the project picked by --project (default: KNIME_CLI_PROJECT, else the first open one) to its own folder,",
    "redrawing the workflow preview. There's no \"save as\". Does nothing if there are no unsaved changes.",
    "Refused (exit 7, SAVE_BLOCKED) for component projects, temporary Hub/Server/archive copies and read-only ones.",
  ],
  examples: ["knime save", "knime save --project KNIME_project --json"],
  async run(ctx) {
    const s = await ctx.session();
    const before = await s.projectApi<ProjectState>("/api/project/state", {}, "project state");
    if (!before.canSave) throw saveBlocked(before);
    if (!before.dirty) {
      return { data: { ...before, saved: false }, text: [`${before.name}: no unsaved changes; nothing saved${before.path ? ` (${before.path})` : ""}`] };
    }
    const r = await s.projectApi<ProjectState>("/api/project/save", {}, `save ${before.name}`);
    if (r.executing) ctx.warn("nodes were executing; they're saved as they were at that moment");
    return { data: r, text: [`saved ${r.name}${r.path ? ` to ${r.path}` : ""}`] };
  },
};

function saveBlocked(p: ProjectState): CliError {
  return new CliError({
    code: "SAVE_BLOCKED", exit: EXIT.REJECTED, message: `Can't save ${p.name}: ${p.saveBlocked ?? "KNIME refuses to save it in place"}`,
    cause: SAVE_BLOCKED_CAUSE, hint: SAVE_BLOCKED_HINT, details: p,
  });
}

/** Project state for READ commands: undefined if the server can't say (older plugin, project not loaded). */
export async function projectState(s: { projectApi<T>(path: string, body?: Record<string, unknown>, context?: string): Promise<T> }): Promise<ProjectState | undefined> {
  try {
    return await s.projectApi<ProjectState>("/api/project/state", {}, "project state");
  } catch {
    return undefined;
  }
}

/** One line on the project's save state, for human output. */
export function saveLine(p: ProjectState | undefined): string | undefined {
  if (!p) return undefined;
  const state = p.dirty ? "unsaved changes (`knime save`)" : "saved";
  return `${p.name}: ${state}${p.canSave ? "" : `; can't be saved in place: ${p.saveBlocked ?? "?"}`}${p.path ? ` — ${p.path}` : ""}`;
}
