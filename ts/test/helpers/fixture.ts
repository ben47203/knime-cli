/**
 * Shared set-up for the end-to-end suite: finds the running KNIME instance the way the CLI does, checks it speaks the
 * API version these tests were written against, and picks the workflow to work in.
 *
 * The suite drives a real KNIME, so it needs one running with the plugin installed and a workflow open. Without one,
 * `connect()` throws straight away (no polling), so every test file fails fast with the same clear message.
 */
import assert from "node:assert/strict";

import { HttpError, KnimeClient, RpcError } from "../../src/client.ts";
import { listInstances, type Instance } from "../../src/discovery.ts";
import type { Projects } from "./types.ts";

/** The plugin API version this suite was written against. Bump together with LocalApiServer.API_VERSION. */
export const EXPECTED_API_VERSION = 2;

/** A workflow addressed the way every `/api/*` request and gateway command does. */
export type Target = {
  projectId: string;
  workflowId: string;
};

export interface Fixture {
  instance: Instance;
  client: KnimeClient;
  /** Root workflow of the first project open in the UI; the tests add their nodes here and remove them again. */
  target: Target;
  projectName: string | null;
}

let cached: Promise<Fixture> | undefined;

/** Discovers the instance once per test file (each file runs in its own process). */
export function connect(): Promise<Fixture> {
  cached ??= discover();
  return cached;
}

async function discover(): Promise<Fixture> {
  const instances = await listInstances();
  // KNIME_CLI_PID picks one instance when several are running; otherwise the most recently started one.
  const wanted = process.env.KNIME_CLI_PID;
  const instance = wanted ? instances.find((i) => String(i.pid) === wanted) : instances[0];
  if (!instance) {
    throw new Error(
      wanted
        ? `No running KNIME instance with pid ${wanted} (found: ${instances.map((i) => i.pid).join(", ") || "none"})`
        : "No running KNIME instance found. Start KNIME with the knime-cli plugin installed, open a workflow, and re-run.",
    );
  }
  // Fail fast on a stale plugin build rather than running checks against old behaviour, which could also disturb
  // the open workflow.
  if (instance.apiVersion !== EXPECTED_API_VERSION) {
    throw new Error(
      `Plugin API v${instance.apiVersion}, suite expects v${EXPECTED_API_VERSION}. ` +
        "Refresh the plugin project in Eclipse (F5), check it rebuilt, and relaunch KNIME.",
    );
  }
  const client = new KnimeClient(instance);
  try {
    await client.waitUntilReady(30_000);
  } catch (e) {
    throw new Error(`KNIME instance pid ${instance.pid} at ${instance.url} isn't answering: ${String(e)}`);
  }
  const { projects } = await client.api<Projects>("/api/projects");
  // KNIME_CLI_PROJECT picks a project by id or name; otherwise the first one the gateway lists, which isn't
  // necessarily the tab in front.
  const wantedProject = process.env.KNIME_CLI_PROJECT;
  const project = wantedProject
    ? projects.find((p) => p.projectId === wantedProject || p.name === wantedProject)
    : projects[0];
  if (!project) {
    throw new Error(wantedProject
      ? `No open project with id or name "${wantedProject}"; open: ${projects.map((p) => p.name ?? p.projectId).join(", ")}`
      : "KNIME is running but no workflow is open; open one and re-run.");
  }
  console.error(`Testing in project "${project.name ?? project.projectId}" (set KNIME_CLI_PROJECT to choose another)`);
  return {
    instance,
    client,
    target: { projectId: project.projectId, workflowId: "root" },
    projectName: project.name,
  };
}

/** Asserts that `call` fails with HTTP `status`, and that the error message contains each of `fragments`. */
export async function expectHttpError(
  call: Promise<unknown> | (() => Promise<unknown>),
  status: number,
  ...fragments: string[]
): Promise<HttpError> {
  let error: unknown;
  try {
    await (typeof call === "function" ? call() : call);
  } catch (e) {
    error = e;
  }
  assert.ok(error, `expected HTTP ${status}, but the call succeeded`);
  assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
  assert.equal(error.status, status, `expected HTTP ${status}, got ${error.message}`);
  for (const f of fragments) {
    assert.ok(error.message.includes(f), `expected the error to mention ${JSON.stringify(f)}: ${error.message}`);
  }
  return error;
}

/** Asserts that a JSON-RPC call fails with `code`. */
export async function expectRpcError(call: Promise<unknown>, code: number): Promise<RpcError> {
  let error: unknown;
  try {
    await call;
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof RpcError, `expected a JSON-RPC error ${code}, got ${error ? String(error) : "success"}`);
  assert.equal(error.code, code, error.message);
  return error;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
