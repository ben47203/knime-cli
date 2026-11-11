/**
 * M2 execution smoke test. With KNIME running (plugin installed) and a workflow open:
 *   npm run smoke:exec
 * Adds a Table Creator to the first open project, executes it with a wait, checks node/status, resets it, reads
 * workflow/errors, and finally undoes the add so the workflow is left as it was.
 */
import { styleText } from "node:util";

import { listInstances } from "../src/discovery.ts";
import { HttpError, KnimeClient } from "../src/client.ts";

type State = "IDLE" | "CONFIGURED" | "QUEUED" | "EXECUTING" | "EXECUTED" | "HALTED";
interface Message {
  type: "WARNING" | "ERROR";
  text: string;
  issue?: string;
  resolutions?: string[];
}
/** Fields the server has no value for are omitted, not null. */
interface NodeState {
  nodeId: string;
  name: string;
  state: State;
  message?: Message;
  progressMessage?: string;
  lastExecutionMs?: number;
}
interface NodeStatus extends NodeState {
  outPorts: { index: number; type: string; summary?: string; inactive: boolean }[];
}
interface WorkflowState {
  stateHash: string;
  nodes: NodeState[];
}
interface ExecResult {
  done: boolean;
  states: Record<string, State>;
  failed: { nodeId: string; name: string; message?: Message }[];
}
interface WorkflowErrors {
  errors: number;
  warnings: number;
  nodes: NodeState[];
}
interface Projects {
  projects: { projectId: string; name: string | null }[];
}
interface WorkflowRead {
  workflow: { nodes?: Record<string, { position?: { x: number; y: number } }> };
}

const TABLE_CREATOR = "org.knime.base.node.io.tablecreator.TableCreator2NodeFactory";

/** The plugin API version this script was written against. Bump together with LocalApiServer.API_VERSION. */
const EXPECTED_API_VERSION = 2;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  const label = ok ? styleText("green", "PASS") : styleText(["red", "bold"], "FAIL");
  console.log(`${label}  ${name}${detail ? styleText("dim", ` - ${detail}`) : ""}`);
  if (!ok) failures++;
}

async function expectStatus(name: string, status: number, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
    check(name, false, "call unexpectedly succeeded");
  } catch (e) {
    check(name, e instanceof HttpError && e.status === status, String(e));
  }
}

async function main(): Promise<void> {
  const [inst] = await listInstances();
  if (!inst) throw new Error("No running KNIME instance found (is the plugin installed and KNIME started?)");
  console.log(`Instance pid=${inst.pid} ${inst.url} KNIME ${inst.knimeVersion} api v${inst.apiVersion}`);
  if (inst.apiVersion !== EXPECTED_API_VERSION) {
    throw new Error(
      `Plugin API v${inst.apiVersion}, script expects v${EXPECTED_API_VERSION}. ` +
        "Refresh the plugin project in Eclipse (F5), check it rebuilt, and relaunch KNIME.",
    );
  }
  const client = new KnimeClient(inst);
  await client.waitUntilReady();

  const { projects } = await client.api<Projects>("/api/projects");
  const project = projects[0];
  if (!project) throw new Error("Open a workflow in KNIME first");
  const target = { projectId: project.projectId, workflowId: "root" };
  console.log(`Project ${project.name ?? project.projectId}`);

  const before = await client.api<WorkflowState>("/api/workflow/state", target);
  check("workflow/state", Boolean(before.stateHash), `${before.nodes.length} node(s)`);
  const again = await client.api<WorkflowState>("/api/workflow/state", target);
  check("stateHash stable without changes", again.stateHash === before.stateHash);

  // Place the new node to the right of everything else so it's easy to spot.
  const { workflow } = await client.api<WorkflowRead>("/api/workflow", target);
  const maxX = Math.max(0, ...Object.values(workflow.nodes ?? {}).map((n) => n.position?.x ?? 0));
  const added = await client.call<{ newNodeId: string }>("WorkflowService.executeWorkflowCommand", {
    ...target,
    workflowCommand: { kind: "add_node", nodeFactory: { className: TABLE_CREATOR }, position: { x: maxX + 150, y: 100 } },
  });
  const nodeId = added.newNodeId;
  check("AddNodeCommand", Boolean(nodeId), `new node ${nodeId}`);
  const node = { ...target, nodeId };

  try {
    const afterAdd = await client.api<WorkflowState>("/api/workflow/state", target);
    const fresh = afterAdd.nodes.find((n) => n.nodeId === nodeId);
    check("new node in workflow/state", Boolean(fresh), fresh?.state);
    check("stateHash changed after add", afterAdd.stateHash !== before.stateHash);

    const status0 = await client.api<NodeStatus>("/api/node/status", node);
    check("node/status before execute", status0.state === "CONFIGURED" || status0.state === "IDLE", status0.state);
    check("node/status out ports", status0.outPorts.length >= 2, status0.outPorts.map((p) => p.type).join(", "));

    // Request validation
    await expectStatus("execute waitMs out of range -> 400", 400, () =>
      client.api("/api/execute", { ...target, nodeIds: [nodeId], waitMs: 99_999 }),
    );
    await expectStatus("execute empty nodeIds -> 400", 400, () => client.api("/api/execute", { ...target, nodeIds: [] }));
    await expectStatus("execute unknown node -> 404", 404, () =>
      client.api("/api/execute", { ...target, nodeIds: ["root:99999"] }),
    );
    await expectStatus("node/status missing nodeId -> 400", 400, () => client.api("/api/node/status", target));

    const exec = await client.api<ExecResult>("/api/execute", { ...target, nodeIds: [nodeId], waitMs: 30_000 });
    check("execute done", exec.done, JSON.stringify(exec.states));
    check("execute -> EXECUTED", exec.states[nodeId] === "EXECUTED", exec.states[nodeId]);
    check("execute no failures", exec.failed.length === 0, JSON.stringify(exec.failed));

    const status1 = await client.api<NodeStatus>("/api/node/status", node);
    check("node/status EXECUTED", status1.state === "EXECUTED");
    check("node/status timing", typeof status1.lastExecutionMs === "number", `${status1.lastExecutionMs} ms`);
    check("node/status table summary", Boolean(status1.outPorts[1]?.summary), status1.outPorts[1]?.summary);

    const waited = await client.api<ExecResult>("/api/wait", { ...target, nodeIds: [nodeId], waitMs: 1000 });
    check("wait returns done when idle", waited.done && waited.states[nodeId] === "EXECUTED");

    const afterExec = await client.api<WorkflowState>("/api/workflow/state", target);
    check("stateHash changed after execute", afterExec.stateHash !== afterAdd.stateHash);

    const reset = await client.api<{ states: Record<string, State> }>("/api/reset", { ...target, nodeIds: [nodeId] });
    const resetState = reset.states[nodeId];
    check("reset -> CONFIGURED/IDLE", resetState === "CONFIGURED" || resetState === "IDLE", resetState);

    const resetAgain = await client.api<{ states: Record<string, State> }>("/api/reset", { ...target, nodeIds: [nodeId] });
    check("reset on never-run node is a no-op", resetAgain.states[nodeId] === resetState, resetAgain.states[nodeId]);

    const cancel = await client.api<{ states: Record<string, State> }>("/api/cancel", { ...target, nodeIds: [nodeId] });
    check("cancel on idle node is harmless", cancel.states[nodeId] === resetState, cancel.states[nodeId]);

    const errors = await client.api<WorkflowErrors>("/api/workflow/errors", target);
    check(
      "workflow/errors",
      errors.nodes.length === errors.errors + errors.warnings && !errors.nodes.some((n) => n.nodeId === nodeId),
      `${errors.errors} error(s), ${errors.warnings} warning(s)`,
    );
  } finally {
    // Execute and reset aren't undoable commands, so the last undo entry is still our add.
    await client.call("WorkflowService.undoWorkflowCommand", target);
    const afterUndo = await client.api<WorkflowState>("/api/workflow/state", target);
    check("undo removes node", !afterUndo.nodes.some((n) => n.nodeId === nodeId));
  }

  console.log(
    failures ? styleText(["red", "bold"], `\n${failures} check(s) failed`) : styleText(["green", "bold"], "\nAll checks passed"),
  );
  process.exitCode = failures ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(styleText("red", e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
