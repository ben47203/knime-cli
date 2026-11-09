/**
 * M1 spike smoke test. With KNIME running (plugin installed) and a workflow open:
 *   npm run smoke
 * Checks the security gates and the RPC allowlist, reads projects + workflow via the side-effect-free /api
 * endpoints, adds a Table Creator node, then undoes and redoes it through the shared command stack.
 * The node is left in place so you can check that the KNIME UI still works (e.g. Cmd+Z removes it).
 */
import { request } from "node:http";
import { listInstances } from "../src/discovery.ts";
import { HttpError, KnimeClient, RpcError } from "../src/client.ts";

interface Projects {
  projects: { projectId: string; name: string | null }[];
}
interface WorkflowRead {
  contentHash: string;
  workflow: { nodes?: Record<string, { position?: { x: number; y: number } }> };
}
interface AddNodeResult {
  kind: string;
  newNodeId: string;
}

const TABLE_CREATOR = "org.knime.base.node.io.tablecreator.TableCreator2NodeFactory";

/** The plugin API version this script was written against. Bump together with LocalApiServer.API_VERSION. */
const EXPECTED_API_VERSION = 2;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Raw request via node:http so we can forge Host/Origin, which fetch won't let us set reliably. */
function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/status", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function expectRpcError(client: KnimeClient, name: string, method: string, code: number): Promise<void> {
  try {
    await client.call(method);
    check(name, false, "call unexpectedly succeeded");
  } catch (e) {
    check(name, e instanceof RpcError && e.code === code, String(e));
  }
}

async function main(): Promise<void> {
  const [inst] = await listInstances();
  if (!inst) throw new Error("No running KNIME instance found (is the plugin installed and KNIME started?)");
  console.log(`Instance pid=${inst.pid} ${inst.url} KNIME ${inst.knimeVersion} api v${inst.apiVersion}`);
  // Fail fast on a stale plugin build (e.g. Eclipse didn't pick up source changes) rather than
  // running checks against old behaviour, which could also disturb the open workflow.
  if (inst.apiVersion !== EXPECTED_API_VERSION) {
    throw new Error(
      `Plugin API v${inst.apiVersion}, script expects v${EXPECTED_API_VERSION}. ` +
        "Refresh the plugin project in Eclipse (F5), check it rebuilt, and relaunch KNIME.",
    );
  }
  const auth = { Authorization: `Bearer ${inst.token}` };
  const hostOk = `127.0.0.1:${inst.port}`;

  // Security gates
  check("no token -> 401", (await rawStatus(inst.port, { Host: hostOk })) === 401);
  check("wrong token -> 401", (await rawStatus(inst.port, { Host: hostOk, Authorization: "Bearer nope" })) === 401);
  check("foreign Host -> 403", (await rawStatus(inst.port, { ...auth, Host: `evil.example:${inst.port}` })) === 403);
  check("Origin present -> 403", (await rawStatus(inst.port, { ...auth, Host: hostOk, Origin: "http://evil.example" })) === 403);
  check("valid request -> 200", (await rawStatus(inst.port, { ...auth, Host: hostOk })) === 200);

  const client = new KnimeClient(inst);
  const status = await client.waitUntilReady();
  check("status ready", status.ready, `api v${status.apiVersion}`);

  // Allowlist: gateway reads that would disturb the UI are refused before they reach the gateway.
  await expectRpcError(client, "getWorkflow via /rpc refused", "WorkflowService.getWorkflow", -32001);
  await expectRpcError(client, "getState via /rpc refused", "ApplicationService.getState", -32001);

  const { projects } = await client.api<Projects>("/api/projects");
  check("/api/projects", true, `${projects.length} open project(s)`);
  const project = projects[0];
  if (!project) throw new Error("Open a workflow in KNIME first");
  const target = { projectId: project.projectId, workflowId: "root" };

  try {
    await client.api("/api/workflow", { projectId: "no-such-project" });
    check("/api/workflow unknown project -> 404", false, "unexpectedly succeeded");
  } catch (e) {
    check("/api/workflow unknown project -> 404", e instanceof HttpError && e.status === 404);
  }

  try {
    await client.api("/api/workflow", { projectId: project.projectId, workflowId: "root:99999" });
    check("/api/workflow unknown workflowId -> 404", false, "unexpectedly succeeded");
  } catch (e) {
    check("/api/workflow unknown workflowId -> 404", e instanceof HttpError && e.status === 404, String(e));
  }

  const before = await client.api<WorkflowRead>("/api/workflow", target);
  const nodes = Object.values(before.workflow.nodes ?? {});
  check("/api/workflow", Boolean(before.contentHash), `${project.name ?? project.projectId}: ${nodes.length} node(s)`);
  const again = await client.api<WorkflowRead>("/api/workflow", target);
  check("contentHash stable without changes", again.contentHash === before.contentHash);

  // Place the new node to the right of everything else so it's easy to spot.
  const maxX = Math.max(0, ...nodes.map((n) => n.position?.x ?? 0));
  const added = await client.call<AddNodeResult>("WorkflowService.executeWorkflowCommand", {
    ...target,
    workflowCommand: {
      kind: "add_node",
      nodeFactory: { className: TABLE_CREATOR },
      position: { x: maxX + 150, y: 100 },
    },
  });
  check("AddNodeCommand", Boolean(added.newNodeId), `new node ${added.newNodeId}`);

  const afterAdd = await client.api<WorkflowRead>("/api/workflow", target);
  check("node present after add", added.newNodeId in (afterAdd.workflow.nodes ?? {}));
  check("contentHash changed", afterAdd.contentHash !== before.contentHash);

  await client.call("WorkflowService.undoWorkflowCommand", target);
  const afterUndo = await client.api<WorkflowRead>("/api/workflow", target);
  check("undo removes node", !(added.newNodeId in (afterUndo.workflow.nodes ?? {})));

  await client.call("WorkflowService.redoWorkflowCommand", target);
  const afterRedo = await client.api<WorkflowRead>("/api/workflow", target);
  check("redo restores node", added.newNodeId in (afterRedo.workflow.nodes ?? {}));

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  console.log("Now in KNIME: the Table Creator should be visible, Cmd+Z should remove it, and editing should still work.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
