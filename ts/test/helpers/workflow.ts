/**
 * Builds throwaway nodes in the open workflow through the gateway's undoable commands, and removes them again.
 *
 * Every structural change goes through `WorkflowService.executeWorkflowCommand`, so it lands on the same undo stack
 * the KNIME UI uses. The builder counts its commands and `teardown()` undoes exactly that many, newest first, which
 * leaves the workflow as it was found. Settings changes, execute, cancel and reset are not commands and don't touch the
 * stack; undoing an add removes the node whatever its settings or state (once it isn't executing).
 *
 * Don't edit the workflow in the KNIME UI while the suite runs: the undo stack is shared, so teardown would undo your
 * edit instead of ours.
 */
import type { KnimeClient } from "../../src/client.ts";
import type { Fixture, Target } from "./fixture.ts";
import { sleep } from "./fixture.ts";
import type { AddNodeResult, CollapseResult, NodeStatus, WorkflowRead, WorkflowState } from "./types.ts";

/**
 * Node factories used by the suite, all from the KNIME 5.12 install and checked there with javap:
 * - TABLE_CREATOR: source node with a default table (the old smoke test executed it); deprecated but still addable.
 * - WAIT: "Wait..." (SleepNodeFactory). Model keys `wait_option` (int, 0 = wait for a duration), `for_hours`,
 *   `for_minutes`, `for_seconds` (default 1), `for_milliseconds` (ints), `path_to_file` (string). Optional flow
 *   variable in port 1, flow variable out port 1. Polls `checkCanceled`, so it can be cancelled.
 * - COLUMN_FILTER: legacy NodeModel saving a DataColumnSpecFilterConfiguration under `column-filter`:
 *   `included_names`/`excluded_names` (string arrays), `filter-type`, `enforce_option` (strings) and `name_pattern`
 *   {`pattern`, `type` (strings), `caseSensitive`, `excludeMatching` (booleans)}. Data in port 1, data out port 1.
 */
export const FACTORIES = {
  TABLE_CREATOR: "org.knime.base.node.io.tablecreator.TableCreator2NodeFactory",
  WAIT: "org.knime.base.node.flowcontrol.sleep.SleepNodeFactory",
  COLUMN_FILTER: "org.knime.base.node.preproc.filter.column.DataColumnSpecFilterNodeFactory",
} as const;

/**
 * Nodes whose default settings hold a secret, tried in order by the redaction test (the first one that adds and shows
 * a redacted path wins). Verified with javap against the 5.12 install:
 * - Credentials Configuration: CredentialsNodeValue always writes a password, either as a transient string
 *   (`password`) or in a Credentials widget config (`credentialsValue` with `isCredentials_Internals`,
 *   `transientPassword`).
 * - DB Connector (modern UI): its AuthenticationParameters hold a Credentials widget, whose persistor always writes
 *   `transientPassword` and `transientSecondFactor` (xtransientstring entries).
 * Send Email was ruled out: a fresh node saves no settings at all (its configuration is null until the dialog is
 * applied), so there is no password entry to redact.
 */
export const SECRET_CANDIDATES = [
  "org.knime.js.base.node.configuration.input.credentials.CredentialsDialogNodeFactory",
  "org.knime.database.node.connector.generic.DBConnectorNodeFactory2",
] as const;

/** Gap between nodes the builder places, in workflow coordinates. */
const STEP_X = 150;

export class WorkflowBuilder {
  readonly client: KnimeClient;
  readonly target: Target;
  #undoable = 0;
  readonly #created = new Set<string>();
  #nextX: number | undefined;

  constructor(fixture: Fixture) {
    this.client = fixture.client;
    this.target = fixture.target;
  }

  /** How many undoable commands this builder has on the stack right now. */
  get undoable(): number {
    return this.#undoable;
  }

  /** Every node id this builder added, including ones since removed by an undo. */
  get created(): string[] {
    return [...this.#created];
  }

  /** Runs one gateway workflow command and counts it for teardown. A failed command leaves nothing to undo. */
  async command<T = unknown>(workflowCommand: Record<string, unknown>): Promise<T> {
    const result = await this.client.call<T>("WorkflowService.executeWorkflowCommand", {
      ...this.target,
      workflowCommand,
    });
    this.#undoable++;
    return result;
  }

  /** Adds a node to the right of everything already in the workflow and returns its id (e.g. `root:12`). */
  async addNode(className: string, row = 0): Promise<string> {
    if (this.#nextX === undefined) {
      const { workflow } = await this.client.api<WorkflowRead>("/api/workflow", this.target);
      const xs = Object.values(workflow.nodes ?? {}).map((n) => n.position?.x ?? 0);
      this.#nextX = Math.max(0, ...xs) + 2 * STEP_X;
    }
    const position = { x: this.#nextX, y: 100 + row * STEP_X };
    this.#nextX += STEP_X;
    const result = await this.command<AddNodeResult>({ kind: "add_node", nodeFactory: { className }, position });
    if (!result?.newNodeId) throw new Error(`add_node for ${className} returned no node id: ${JSON.stringify(result)}`);
    this.#created.add(result.newNodeId);
    return result.newNodeId;
  }

  /** Connects an output port to an input port. Port 0 is every node's implicit flow variable port. */
  async connect(sourceNodeId: string, sourcePortIdx: number, destinationNodeId: string, destinationPortIdx: number) {
    await this.command({ kind: "connect", sourceNodeId, sourcePortIdx, destinationNodeId, destinationPortIdx });
  }

  /** Collapses nodes into a new metanode and returns its id. Undo (or teardown) expands it again. */
  async collapse(nodeIds: string[]): Promise<string> {
    const result = await this.command<CollapseResult>({
      kind: "collapse",
      nodeIds,
      annotationIds: [],
      connectionBendpoints: {},
      containerType: "metanode",
    });
    if (!result?.newNodeId) throw new Error(`collapse returned no node id: ${JSON.stringify(result)}`);
    return result.newNodeId;
  }

  /** Undoes this builder's most recent command. */
  async undo(): Promise<void> {
    if (this.#undoable === 0) throw new Error("Nothing of ours left to undo");
    await this.client.call("WorkflowService.undoWorkflowCommand", this.target);
    this.#undoable--;
  }

  /** Redoes the command most recently undone (ours, if nothing else touched the stack), putting it back on the stack. */
  async redo(): Promise<void> {
    await this.client.call("WorkflowService.redoWorkflowCommand", this.target);
    this.#undoable++;
  }

  /**
   * Leaves the workflow as it was found: cancels any of our nodes that are still running (an executing node can't be
   * removed), undoes every command we ran in reverse, then checks our nodes are gone. If an undo fails, the leftovers
   * are deleted as a fallback (which leaves one delete on the undo stack) and the problem is reported by throwing.
   * Safe to call more than once. With KNIME_CLI_KEEP=1 it leaves everything in place, so the built workflow can be
   * inspected in the UI (undo there, or close without saving, to remove it).
   */
  async teardown(): Promise<void> {
    if (process.env.KNIME_CLI_KEEP === "1") {
      console.error(`KNIME_CLI_KEEP=1: leaving ${this.#created.size} test node(s) in the workflow`);
      this.#undoable = 0;
      return;
    }
    const problems: string[] = [];
    const ours = (s: WorkflowState) => s.nodes.filter((n) => this.#created.has(n.nodeId));

    try {
      const busy = ours(await this.#state()).filter((n) => n.state === "QUEUED" || n.state === "EXECUTING");
      if (busy.length) {
        const nodeIds = busy.map((n) => n.nodeId);
        await this.client.api("/api/cancel", { ...this.target, nodeIds });
        const waited = await this.client.api<{ done: boolean }>("/api/wait", { ...this.target, nodeIds, waitMs: 30_000 });
        if (!waited.done) problems.push(`nodes still running after cancel: ${nodeIds.join(", ")}`);
      }
    } catch (e) {
      problems.push(`cancelling our nodes failed: ${String(e)}`);
    }

    while (this.#undoable > 0) {
      try {
        await this.undo();
      } catch (e) {
        problems.push(`undo failed with ${this.#undoable} command(s) left: ${String(e)}`);
        break;
      }
    }

    try {
      const leftovers = ours(await this.#state()).map((n) => n.nodeId);
      if (leftovers.length) {
        problems.push(`nodes left behind after undo: ${leftovers.join(", ")}; deleting them`);
        await this.client.call("WorkflowService.executeWorkflowCommand", {
          ...this.target,
          workflowCommand: { kind: "delete", nodeIds: leftovers, annotationIds: [], connectionIds: [] },
        });
      }
    } catch (e) {
      problems.push(`checking for leftovers failed: ${String(e)}`);
    }

    this.#undoable = 0;
    if (problems.length) throw new Error(`Teardown could not restore the workflow cleanly:\n- ${problems.join("\n- ")}`);
  }

  #state(): Promise<WorkflowState> {
    return this.client.api<WorkflowState>("/api/workflow/state", this.target);
  }
}

/** One node's status. */
export function nodeStatus(client: KnimeClient, target: Target, nodeId: string): Promise<NodeStatus> {
  return client.api<NodeStatus>("/api/node/status", { ...target, nodeId });
}

/** Polls a node's status until `until` holds, or fails after `timeoutMs`. */
export async function waitForNode(
  client: KnimeClient,
  target: Target,
  nodeId: string,
  until: (s: NodeStatus) => boolean,
  timeoutMs = 15_000,
): Promise<NodeStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await nodeStatus(client, target, nodeId);
    if (until(s)) return s;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${nodeId}; last state ${s.state}`);
    await sleep(100);
  }
}
