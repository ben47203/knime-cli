/**
 * Execution control: execute, wait, cancel, reset. Builds two small chains to the right of the open workflow:
 *   Table Creator -> Column Filter          (quick, for execute + wait)
 *   Wait (1 s)    -> Wait (30 s, via flow variable ports)   (slow, for timeouts, cancel and 409s)
 * Every request names its nodeIds: omitting them would act on the user's whole workflow.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import type { ExecResult, SetResult, StatesResult } from "./helpers/types.ts";
import { FACTORIES, nodeStatus, waitForNode, WorkflowBuilder } from "./helpers/workflow.ts";

// Top-level, so a missing KNIME fails the file once with a clear message instead of failing every test.
const fx: Fixture = await connect();
let wf: WorkflowBuilder;
let tc: string;
let cf: string;
/** Short Wait (default 1 s) feeding the long one. */
let waitA: string;
/** Long Wait, set to 30 s for the duration of the slow tests. */
let waitB: string;

before(async () => {
  wf = new WorkflowBuilder(fx);
  tc = await wf.addNode(FACTORIES.TABLE_CREATOR);
  cf = await wf.addNode(FACTORIES.COLUMN_FILTER);
  await wf.connect(tc, 1, cf, 1);
  waitA = await wf.addNode(FACTORIES.WAIT, 1);
  waitB = await wf.addNode(FACTORIES.WAIT, 1);
  await wf.connect(waitA, 1, waitB, 1);
});

after(async () => {
  await wf?.teardown();
});

function execute(nodeIds: string[], waitMs?: number): Promise<ExecResult> {
  return fx.client.api<ExecResult>("/api/execute", { ...fx.target, nodeIds, ...(waitMs === undefined ? {} : { waitMs }) });
}
function wait(nodeIds: string[], waitMs?: number): Promise<ExecResult> {
  return fx.client.api<ExecResult>("/api/wait", { ...fx.target, nodeIds, ...(waitMs === undefined ? {} : { waitMs }) });
}
function cancel(nodeIds: string[]): Promise<StatesResult> {
  return fx.client.api<StatesResult>("/api/cancel", { ...fx.target, nodeIds });
}
function reset(nodeIds: string[]): Promise<StatesResult> {
  return fx.client.api<StatesResult>("/api/reset", { ...fx.target, nodeIds });
}
function setSeconds(nodeId: string, seconds: number): Promise<SetResult> {
  return fx.client.api<SetResult>("/api/node/settings/set", { ...fx.target, nodeId, model: { for_seconds: seconds } });
}

describe("execute + wait", () => {
  test("executes a chain up to the target and waits for it", { timeout: 60_000 }, async () => {
    const res = await execute([cf], 30_000);
    assert.equal(res.done, true);
    assert.deepEqual(Object.keys(res.states), [cf], "states cover the targets only");
    assert.equal(res.states[cf], "EXECUTED");
    assert.deepEqual(res.failed, []);

    // The predecessor ran too.
    assert.equal((await nodeStatus(fx.client, fx.target, tc)).state, "EXECUTED");
    const s = await nodeStatus(fx.client, fx.target, cf);
    assert.equal(s.state, "EXECUTED");
    assert.equal(typeof s.lastExecutionMs, "number");
    assert.ok(s.outPorts[1]?.summary, `table port has a summary: ${JSON.stringify(s.outPorts)}`);
  });

  test("executing an already executed node is a no-op that reports done", async () => {
    const res = await execute([cf], 5_000);
    assert.equal(res.done, true);
    assert.equal(res.states[cf], "EXECUTED");
  });

  test("wait on finished nodes returns at once", async () => {
    const started = Date.now();
    const res = await wait([tc, cf], 10_000);
    assert.ok(Date.now() - started < 5_000, "didn't sit out waitMs");
    assert.equal(res.done, true);
    assert.deepEqual(res.states, { [tc]: "EXECUTED", [cf]: "EXECUTED" });
  });

  test("waitMs defaults to 0 (no waiting)", async () => {
    const res = await wait([cf]);
    assert.equal(res.done, true);
  });

  test("reset puts the chain back to configured, successors included", async () => {
    const res = await reset([tc]);
    assert.equal(res.states[tc], "CONFIGURED");
    assert.equal((await nodeStatus(fx.client, fx.target, cf)).state, "CONFIGURED");
  });
});

describe("request validation", () => {
  test("waitMs out of range -> 400", async () => {
    for (const waitMs of [-1, 30_001, 99_999]) {
      await expectHttpError(execute([tc], waitMs), 400, "waitMs");
      await expectHttpError(wait([tc], waitMs), 400, "waitMs");
    }
  });

  test("empty nodeIds -> 400 on every execution route", async () => {
    for (const route of ["/api/execute", "/api/wait", "/api/cancel", "/api/reset"]) {
      await expectHttpError(fx.client.api(route, { ...fx.target, nodeIds: [] }), 400, "nodeIds must not be empty");
    }
  });

  test("blank nodeIds entry -> 400", async () => {
    await expectHttpError(fx.client.api("/api/execute", { ...fx.target, nodeIds: [""] }), 400, "nodeIds entry");
  });

  test("unknown node -> 404, and nothing is started", async () => {
    await expectHttpError(execute([tc, "root:99999"]), 404, "root:99999");
    assert.equal((await nodeStatus(fx.client, fx.target, tc)).state, "CONFIGURED");
  });

  test("malformed node id -> 400", async () => {
    await expectHttpError(execute(["root:x"]), 400);
  });

  test("unknown field -> 400 (e.g. a misspelt waitMs)", async () => {
    await expectHttpError(fx.client.api("/api/execute", { ...fx.target, nodeIds: [tc], waitMS: 10 }), 400, "waitMS");
  });
});

describe("timeouts, cancel and busy nodes", () => {
  test("slow chain: wait timeout, 409 on reset while busy, cancel", { timeout: 90_000 }, async (t) => {
    const set = await setSeconds(waitB, 30);
    assert.equal(set.changed, true);
    t.after(async () => {
      // Restore the default even if an assertion failed (teardown cancels first if needed).
      await cancel([waitA, waitB]);
      await wait([waitA, waitB], 30_000);
      await setSeconds(waitB, 1);
    });

    await t.test("execute with a short waitMs returns not done after about waitMs", async () => {
      const started = Date.now();
      const res = await execute([waitB], 500);
      const elapsed = Date.now() - started;
      assert.equal(res.done, false);
      assert.ok(res.states[waitB] === "QUEUED" || res.states[waitB] === "EXECUTING", res.states[waitB]);
      assert.ok(elapsed >= 450, `returned after ${elapsed} ms, before waitMs`);
      assert.ok(elapsed < 10_000, `took ${elapsed} ms`);
    });

    await t.test("wait with waitMs 0 reports the current state without blocking", async () => {
      const started = Date.now();
      const res = await wait([waitB], 0);
      assert.equal(res.done, false);
      assert.ok(Date.now() - started < 2_000);
    });

    await waitForNode(fx.client, fx.target, waitB, (s) => s.state === "EXECUTING", 15_000);
    assert.equal((await nodeStatus(fx.client, fx.target, waitA)).state, "EXECUTED");

    await t.test("reset of an executing node -> 409", async () => {
      await expectHttpError(reset([waitB]), 409, waitB, "cancel it first");
    });

    await t.test("reset of a node whose successor is executing -> 409", async () => {
      await expectHttpError(reset([waitA]), 409, waitA, "successors");
      assert.equal((await nodeStatus(fx.client, fx.target, waitA)).state, "EXECUTED", "nothing was reset");
    });

    await t.test("reset is all-or-nothing: an idle target alongside a busy one is left alone", async () => {
      await expectHttpError(reset([tc, waitB]), 409);
    });

    await t.test("node/status of an executing node", async () => {
      const s = await nodeStatus(fx.client, fx.target, waitB);
      assert.equal(s.state, "EXECUTING");
    });

    await t.test("cancel stops it; wait then reports done", async () => {
      const res = await cancel([waitB]);
      assert.ok(waitB in res.states);
      const waited = await wait([waitB], 15_000);
      assert.equal(waited.done, true, "cancelled within 15 s");
      assert.equal(waited.states[waitB], "CONFIGURED");
      assert.equal((await nodeStatus(fx.client, fx.target, waitA)).state, "EXECUTED", "predecessor kept its result");
    });
  });

  test("reset of an executed node -> CONFIGURED", async () => {
    // waitA ran in the previous test.
    const before = await nodeStatus(fx.client, fx.target, waitA);
    if (before.state !== "EXECUTED") await execute([waitA], 10_000);
    const res = await reset([waitA]);
    assert.equal(res.states[waitA], "CONFIGURED");
  });

  test("reset of a never-run node is an idempotent no-op", async () => {
    const fresh = await wf.addNode(FACTORIES.WAIT, 2);
    const s0 = (await nodeStatus(fx.client, fx.target, fresh)).state;
    assert.ok(s0 === "CONFIGURED" || s0 === "IDLE", s0);
    const r1 = await reset([fresh]);
    const r2 = await reset([fresh]);
    assert.equal(r1.states[fresh], s0);
    assert.equal(r2.states[fresh], s0);
  });

  test("cancel of an idle node is harmless", async () => {
    const res = await cancel([tc]);
    assert.equal(res.states[tc], "CONFIGURED");
  });
});
