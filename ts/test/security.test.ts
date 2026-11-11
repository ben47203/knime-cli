/**
 * Request gates of LocalApiServer and RpcAllowlist: auth, Host and Origin checks, method/content-type checks, strict
 * request parsing and the RPC allowlist. Read-only: nothing here changes the workflow.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { connect, expectRpcError, type Fixture } from "./helpers/fixture.ts";
import { raw, rawPost } from "./helpers/raw.ts";

// Top-level, so a missing KNIME fails the file once with a clear message instead of failing every test.
const fx: Fixture = await connect();

function errorOf(res: { json: unknown }): string {
  return (res.json as { error?: string } | undefined)?.error ?? "";
}

describe("authentication", () => {
  test("no token -> 401 with WWW-Authenticate", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Authorization: null } });
    assert.equal(res.status, 401);
    assert.equal(res.headers["www-authenticate"], "Bearer");
  });

  test("wrong token -> 401", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Authorization: "Bearer nope" } });
    assert.equal(res.status, 401);
  });

  test("token without the Bearer scheme -> 401", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Authorization: fx.instance.token } });
    assert.equal(res.status, 401);
  });

  test("auth is checked on /api and /rpc too, not just /status", async () => {
    for (const path of ["/api/projects", "/rpc"]) {
      const res = await raw(fx.instance, { method: "POST", path, body: {}, headers: { Authorization: null } });
      assert.equal(res.status, 401, path);
    }
  });

  test("valid request -> 200", async () => {
    const res = await raw(fx.instance, { path: "/status" });
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });
});

describe("Host and Origin", () => {
  test("foreign Host -> 403", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Host: `evil.example:${fx.instance.port}` } });
    assert.equal(res.status, 403);
    assert.match(errorOf(res), /Host/);
  });

  test("Host without the port -> 403", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Host: "127.0.0.1" } });
    assert.equal(res.status, 403);
  });

  test("Host on another port -> 403", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Host: `127.0.0.1:${fx.instance.port + 1}` } });
    assert.equal(res.status, 403);
  });

  test("missing Host -> 403", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Host: null } });
    assert.equal(res.status, 403);
  });

  test("localhost:<port> is accepted", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Host: `localhost:${fx.instance.port}` } });
    assert.equal(res.status, 200);
  });

  test("any Origin header -> 403, even with a valid token", async () => {
    for (const origin of ["http://evil.example", `http://127.0.0.1:${fx.instance.port}`, "null"]) {
      const res = await raw(fx.instance, { path: "/status", headers: { Origin: origin } });
      assert.equal(res.status, 403, origin);
    }
  });

  test("Origin is rejected before auth is checked (no token oracle for browsers)", async () => {
    const res = await raw(fx.instance, { path: "/status", headers: { Origin: "http://evil.example", Authorization: null } });
    assert.equal(res.status, 403);
  });
});

describe("routing and methods", () => {
  test("unknown route -> 404", async () => {
    const res = await rawPost(fx.instance, "/api/no-such-route", {});
    assert.equal(res.status, 404);
    const res2 = await raw(fx.instance, { path: "/nope" });
    assert.equal(res2.status, 404);
  });

  test("POST /status -> 405", async () => {
    const res = await raw(fx.instance, { method: "POST", path: "/status", body: {} });
    assert.equal(res.status, 405);
  });

  test("GET on an /api route -> 405", async () => {
    const res = await raw(fx.instance, { path: "/api/projects" });
    assert.equal(res.status, 405);
  });

  test("non-JSON content type -> 415", async () => {
    const res = await raw(fx.instance, {
      method: "POST",
      path: "/api/projects",
      body: "{}",
      headers: { "Content-Type": "text/plain" },
    });
    assert.equal(res.status, 415);
  });
});

describe("strict request parsing", () => {
  test("unknown request field -> 400 naming the field", async () => {
    const res = await rawPost(fx.instance, "/api/projects", { bogus: 1 });
    assert.equal(res.status, 400);
    assert.match(errorOf(res), /bogus/);
  });

  test("unknown field on a workflow route -> 400 listing allowed fields", async () => {
    const res = await rawPost(fx.instance, "/api/workflow/state", { ...fx.target, workflowID: "root" });
    assert.equal(res.status, 400);
    assert.match(errorOf(res), /workflowID/);
    assert.match(errorOf(res), /projectId/);
  });

  test("malformed JSON -> 400", async () => {
    const res = await rawPost(fx.instance, "/api/projects", "{");
    assert.equal(res.status, 400);
  });

  test("trailing content after the object -> 400", async () => {
    const res = await rawPost(fx.instance, "/api/projects", "{} {}");
    assert.equal(res.status, 400);
  });

  test("body that isn't an object -> 400", async () => {
    for (const body of ["[]", "null", "1", '"x"']) {
      const res = await rawPost(fx.instance, "/api/workflow/state", body);
      assert.equal(res.status, 400, body);
    }
  });

  test("wrong field type -> 400", async () => {
    const res = await rawPost(fx.instance, "/api/workflow/state", { projectId: 42 });
    // Jackson coerces scalars to String by default, which then fails as an unknown project rather than a type error.
    assert.ok(res.status === 400 || res.status === 404, `got ${res.status} ${res.text}`);
    const res2 = await rawPost(fx.instance, "/api/workflow/state", { projectId: { a: 1 } });
    assert.equal(res2.status, 400);
  });

  test("missing required field -> 400", async () => {
    const res = await rawPost(fx.instance, "/api/workflow/state", {});
    assert.equal(res.status, 400);
    assert.match(errorOf(res), /projectId is required/);
  });
});

describe("RPC allowlist", () => {
  test("non-allowlisted gateway methods -> JSON-RPC error -32001 (HTTP 200)", async () => {
    // These two would evict the UI's workflow snapshot / app-state baseline if they ever reached the gateway.
    for (const method of ["WorkflowService.getWorkflow", "ApplicationService.getState", "NodeService.changeNodeStates"]) {
      const res = await rawPost(fx.instance, "/rpc", { jsonrpc: "2.0", id: 7, method, params: {} });
      assert.equal(res.status, 200, method);
      const msg = res.json as { id: unknown; error?: { code: number; message: string } };
      assert.equal(msg.id, 7);
      assert.equal(msg.error?.code, -32001, `${method}: ${res.text}`);
      assert.match(msg.error?.message ?? "", /not available via knime-cli/);
    }
  });

  test("the client surfaces the refusal as an RpcError", async () => {
    await expectRpcError(fx.client.call("WorkflowService.getWorkflow", fx.target), -32001);
  });

  test("method names are matched exactly (no case or whitespace tricks)", async () => {
    for (const method of ["workflowservice.executeWorkflowCommand", "WorkflowService.executeWorkflowCommand "]) {
      const res = await rawPost(fx.instance, "/rpc", { jsonrpc: "2.0", id: 1, method, params: {} });
      assert.equal((res.json as { error?: { code: number } }).error?.code, -32001, JSON.stringify(method));
    }
  });

  test("duplicate keys can't smuggle a second method -> parse error", async () => {
    const body =
      '{"jsonrpc":"2.0","id":1,"method":"WorkflowService.undoWorkflowCommand","method":"WorkflowService.getWorkflow"}';
    const res = await rawPost(fx.instance, "/rpc", body);
    assert.equal((res.json as { error?: { code: number } }).error?.code, -32700);
  });

  test("batches -> -32600; missing method -> -32600; garbage -> -32700", async () => {
    const batch = await rawPost(fx.instance, "/rpc", [{ jsonrpc: "2.0", id: 1, method: "WorkflowService.undoWorkflowCommand" }]);
    assert.equal((batch.json as { error?: { code: number } }).error?.code, -32600);
    const noMethod = await rawPost(fx.instance, "/rpc", { jsonrpc: "2.0", id: 1 });
    assert.equal((noMethod.json as { error?: { code: number } }).error?.code, -32600);
    const garbage = await rawPost(fx.instance, "/rpc", "{nope");
    assert.equal((garbage.json as { error?: { code: number } }).error?.code, -32700);
  });
});
