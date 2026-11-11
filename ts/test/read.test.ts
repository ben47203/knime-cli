/**
 * Side-effect-free read endpoints: /status, projects, workflow, node/status, workflow/state, workflow/errors. Adds a
 * Table Creator (and a Wait node for the errors check) and removes them again in after().
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { connect, EXPECTED_API_VERSION, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import type {
  ExecResult,
  Projects,
  SetResult,
  StatesResult,
  Status,
  WorkflowErrors,
  WorkflowRead,
  WorkflowState,
} from "./helpers/types.ts";
import { FACTORIES, nodeStatus, WorkflowBuilder } from "./helpers/workflow.ts";

// Top-level, so a missing KNIME fails the file once with a clear message instead of failing every test.
const fx: Fixture = await connect();
let wf: WorkflowBuilder;
/** A Table Creator added for these tests. */
let tc: string;
let before0: WorkflowRead;
let state0: WorkflowState;

before(async () => {
  wf = new WorkflowBuilder(fx);
  before0 = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
  state0 = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
  tc = await wf.addNode(FACTORIES.TABLE_CREATOR);
});

after(async () => {
  await wf?.teardown();
});

const SHA256 = /^[0-9a-f]{64}$/;

describe("/status", () => {
  test("reports the API version, KNIME version, pid and readiness", async () => {
    const s = await fx.client.status();
    assert.equal(s.apiVersion, EXPECTED_API_VERSION);
    assert.equal(s.ready, true);
    assert.equal(s.pid, fx.instance.pid);
    assert.equal(typeof s.knimeVersion, "string");
    assert.match(s.knimeVersion, /^\d+\.\d+\.\d+/);
    // The discovery file and /status come from the same values.
    assert.equal(s.knimeVersion, fx.instance.knimeVersion);
    assert.equal(s.apiVersion, fx.instance.apiVersion);
    for (const key of ["apiVersion", "knimeVersion", "pid", "ready"] satisfies (keyof Status)[]) {
      assert.ok(key in s, `/status has ${key}`);
    }
  });
});

describe("/api/projects", () => {
  test("lists the open projects", async () => {
    const { projects } = await fx.client.api<Projects>("/api/projects");
    assert.ok(projects.length >= 1);
    for (const p of projects) {
      assert.equal(typeof p.projectId, "string");
      assert.ok(p.name === null || typeof p.name === "string");
    }
    assert.ok(projects.some((p) => p.projectId === fx.target.projectId));
  });
});

describe("/api/workflow", () => {
  test("returns the workflow entity with a contentHash that is stable without changes", async () => {
    const a = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    const b = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    assert.match(a.contentHash, SHA256);
    assert.equal(a.contentHash, b.contentHash);
    const node = a.workflow.nodes?.[tc];
    assert.ok(node, `${tc} missing from the workflow`);
    assert.equal(node.id, tc);
    assert.equal(node.kind, "node");
  });

  test("contentHash changed when our node was added", async () => {
    const now = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    assert.notEqual(now.contentHash, before0.contentHash);
    assert.ok(!(tc in (before0.workflow.nodes ?? {})));
  });

  test("workflowId defaults to the root", async () => {
    const withRoot = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    const withoutId = await fx.client.api<WorkflowRead>("/api/workflow", { projectId: fx.target.projectId });
    assert.equal(withoutId.contentHash, withRoot.contentHash);
  });

  test("unknown project -> 404", async () => {
    await expectHttpError(fx.client.api("/api/workflow", { projectId: "no-such-project" }), 404);
  });

  test("unknown workflowId -> 404", async () => {
    await expectHttpError(fx.client.api("/api/workflow", { ...fx.target, workflowId: "root:99999" }), 404);
  });

  test("workflowId of a plain node (not a metanode/component) -> 400", async () => {
    await expectHttpError(fx.client.api("/api/workflow", { ...fx.target, workflowId: tc }), 400);
  });

  test("malformed workflowId -> 400", async () => {
    for (const workflowId of ["root:x", "garbage", "foo:3"]) {
      await expectHttpError(fx.client.api("/api/workflow", { ...fx.target, workflowId }), 400, "workflowId");
    }
  });
});

describe("/api/node/status", () => {
  test("describes a fresh node: state, name and out ports", async () => {
    const s = await nodeStatus(fx.client, fx.target, tc);
    assert.equal(s.nodeId, tc);
    assert.equal(typeof s.name, "string");
    assert.ok(s.state === "CONFIGURED" || s.state === "IDLE", s.state);
    assert.equal(s.lastExecutionMs, undefined, "never ran, so no timing");
    assert.equal(s.message, undefined);
    // Port 0 is the implicit flow variable port, port 1 the table.
    assert.ok(s.outPorts.length >= 2, JSON.stringify(s.outPorts));
    s.outPorts.forEach((p, i) => {
      assert.equal(p.index, i);
      assert.equal(typeof p.type, "string");
      assert.equal(p.inactive, false);
    });
  });

  test("unknown nodeId -> 404", async () => {
    await expectHttpError(fx.client.api("/api/node/status", { ...fx.target, nodeId: "root:99999" }), 404, "root:99999");
  });

  test("malformed nodeId -> 400", async () => {
    // "garbage" and "foo:3" would parse as the root and root:3 without the server's own format check.
    for (const nodeId of ["root:x", "root:", "root:3:abc", "garbage", "foo:3", "root:-1", " root:3"]) {
      await expectHttpError(fx.client.api("/api/node/status", { ...fx.target, nodeId }), 400, "nodeId");
    }
  });

  test("missing or blank nodeId -> 400", async () => {
    await expectHttpError(fx.client.api("/api/node/status", fx.target), 400, "nodeId is required");
    await expectHttpError(fx.client.api("/api/node/status", { ...fx.target, nodeId: " " }), 400, "nodeId is required");
  });

  test("unknown project -> 404", async () => {
    await expectHttpError(fx.client.api("/api/node/status", { projectId: "no-such-project", nodeId: tc }), 404);
  });
});

describe("/api/workflow/state", () => {
  test("stateHash changed when our node was added", async () => {
    const now = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    assert.notEqual(now.stateHash, state0.stateHash);
    assert.ok(now.nodes.some((n) => n.nodeId === tc));
    assert.ok(!state0.nodes.some((n) => n.nodeId === tc));
  });

  test("lists every node with a stateHash that is stable without changes", async () => {
    const a = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    const b = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    assert.match(a.stateHash, SHA256);
    assert.equal(a.stateHash, b.stateHash);
    const ids = a.nodes.map((n) => n.nodeId).sort();
    const entityIds = Object.keys((await fx.client.api<WorkflowRead>("/api/workflow", fx.target)).workflow.nodes ?? {}).sort();
    assert.deepEqual(ids, entityIds, "workflow/state and workflow list the same nodes");
  });

  test("stateHash changes when a node executes, and changes back after a reset", async () => {
    const s0 = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    const exec = await fx.client.api<ExecResult>("/api/execute", { ...fx.target, nodeIds: [tc], waitMs: 30_000 });
    assert.equal(exec.states[tc], "EXECUTED");
    const s1 = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    assert.notEqual(s1.stateHash, s0.stateHash);
    assert.equal(s1.nodes.find((n) => n.nodeId === tc)?.state, "EXECUTED");

    await fx.client.api<StatesResult>("/api/reset", { ...fx.target, nodeIds: [tc] });
    const s2 = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    assert.notEqual(s2.stateHash, s1.stateHash);
    assert.equal(s2.stateHash, s0.stateHash, "same ids, states and messages as before executing");
  });
});

describe("/api/workflow/errors", () => {
  test("counts add up and every listed node has a message", async () => {
    const e = await fx.client.api<WorkflowErrors>("/api/workflow/errors", fx.target);
    assert.equal(e.nodes.length, e.errors + e.warnings);
    assert.equal(e.nodes.filter((n) => n.message?.type === "ERROR").length, e.errors);
    for (const n of e.nodes) assert.ok(n.message, `${n.nodeId} listed without a message`);
    assert.ok(!e.nodes.some((n) => n.nodeId === tc), "a clean Table Creator isn't listed");
  });

  test("lists a node that has an error", async (t) => {
    // A Wait node in "wait for file" mode with a path that isn't a local file should fail to configure. That depends
    // on the node's own validation, so skip (rather than fail) if it doesn't produce a message.
    const wait = await wf.addNode(FACTORIES.WAIT, 1);
    let set: SetResult;
    try {
      set = await fx.client.api<SetResult>("/api/node/settings/set", {
        ...fx.target,
        nodeId: wait,
        model: { wait_option: 2, path_to_file: "knime-cli-test://not/a/local/file" },
      });
    } catch (e) {
      t.skip(`couldn't put the Wait node into an error state: ${String(e)}`);
      return;
    }
    const status = await nodeStatus(fx.client, fx.target, wait);
    if (!status.message) {
      t.skip(`Wait node in file mode configured without a message (state ${status.state})`);
      return;
    }
    assert.deepEqual(set.message, status.message);
    const e = await fx.client.api<WorkflowErrors>("/api/workflow/errors", fx.target);
    const listed = e.nodes.find((n) => n.nodeId === wait);
    assert.ok(listed, `${wait} has message ${JSON.stringify(status.message)} but isn't in workflow/errors`);
    assert.deepEqual(listed.message, status.message);
  });

  test("unknown project -> 404", async () => {
    await expectHttpError(fx.client.api("/api/workflow/errors", { projectId: "no-such-project" }), 404);
  });
});

describe("gateway command stack via /rpc", () => {
  test("undo removes an added node and redo restores it, both visible to the reads", async () => {
    const node = await wf.addNode(FACTORIES.TABLE_CREATOR, 1);
    const added = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    assert.ok(node in (added.workflow.nodes ?? {}));

    await wf.undo();
    const undone = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    assert.ok(!(node in (undone.workflow.nodes ?? {})), "undo removed the node");
    assert.notEqual(undone.contentHash, added.contentHash);

    await wf.redo();
    const redone = await fx.client.api<WorkflowRead>("/api/workflow", fx.target);
    assert.ok(node in (redone.workflow.nodes ?? {}), "redo restored it under the same id");
  });
});
