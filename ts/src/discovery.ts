import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Instance {
  apiVersion: number;
  knimeVersion: string;
  pid: number;
  port: number;
  url: string;
  token: string;
  startedAt: string;
  file: string;
}

/** `KNIME_CLI_HOME` overrides `~/.knime-cli` (used by tests). */
export function instancesDir(): string {
  return join(process.env.KNIME_CLI_HOME ?? join(homedir(), ".knime-cli"), "instances");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Lists running KNIME instances. Files left by crashed instances (dead PID) are removed,
 * since the plugin can't clean up after SIGKILL.
 */
export async function listInstances(): Promise<Instance[]> {
  const dir = instancesDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const found: Instance[] = [];
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const file = join(dir, name);
    let inst: Instance;
    try {
      inst = { ...JSON.parse(await readFile(file, "utf8")), file };
    } catch {
      continue; // unreadable or mid-write; skip rather than fail discovery
    }
    if (!isAlive(inst.pid)) {
      await rm(file, { force: true });
      continue;
    }
    found.push(inst);
  }
  return found.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
