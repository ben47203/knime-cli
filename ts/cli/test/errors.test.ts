import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpError, RpcError } from "../../src/client.ts";
import { CliError, EXIT, nodeMessageHint, translate, TRANSLATIONS } from "../errors.ts";
import { errorTable } from "../guide.ts";

const cases: [unknown, string, number][] = [
  [new HttpError(504, "KNIME didn't confirm the command within 30000 ms"), "GATEWAY_TIMEOUT", EXIT.GATEWAY],
  [new HttpError(503, "3 earlier calls are still unanswered"), "GATEWAY_STALLED", EXIT.GATEWAY],
  [new HttpError(503, "KNIME UI not initialised yet"), "NOT_READY", EXIT.UNAVAILABLE],
  [new HttpError(400, "Unknown setting /model/renamings/1; existing keys: a, b"), "UNKNOWN_SETTING", EXIT.REJECTED],
  [new HttpError(400, "Invalid nodeId: foo:3; expected root or root:<n>[:<n>...]"), "INVALID_NODE_ID", EXIT.REJECTED],
  [new HttpError(400, "The node rejected these settings: String for key \"splitCriterion\" not found"), "SETTINGS_REJECTED", EXIT.REJECTED],
  [new HttpError(400, "/model/password holds a password or credentials and can't be changed through this API"), "SETTING_PROTECTED", EXIT.REJECTED],
  [new HttpError(400, "root:5 is a metanode, which has no settings of its own"), "METANODE_HAS_NO_SETTINGS", EXIT.REJECTED],
  [new HttpError(409, "Cannot change settings of root:3: it or a successor is queued or executing"), "BUSY", EXIT.CONFLICT],
  [new HttpError(404, "No open project with id x"), "NOT_FOUND", EXIT.NOT_FOUND],
  [new HttpError(401, "Unauthorized"), "UNAUTHORISED", EXIT.UNAVAILABLE],
  [new RpcError(-32600, "Connection could not be created", null), "CONNECTION_FAILED", EXIT.REJECTED],
  [new RpcError(-32001, "Method not allowed", null), "RPC_NOT_ALLOWED", EXIT.REJECTED],
  [new RpcError(-32000, "Something odd", null), "RPC_ERROR", EXIT.REJECTED],
  // A gateway stack trace passes through the plugin's RpcAllowlist class; that alone isn't a refusal.
  [new RpcError(-32600, "Cannot do that", { stackTrace: "at com.ben47203.knimecli.server.http.RpcAllowlist.handle" }), "RPC_ERROR", EXIT.REJECTED],
  [new RpcError(-32600, "Annotation not found\n * No workflow annotation found for id root_9", null), "ANNOTATION_NOT_FOUND", EXIT.NOT_FOUND],
  [new RpcError(-32600, "Failed to parse color\n * Invalid hex string <green>", { stackTrace: "RpcAllowlist.handle" }), "BAD_COLOUR", EXIT.USAGE],
  [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), "NO_CONNECTION", EXIT.UNAVAILABLE],
  [new Error("boom"), "ERROR", EXIT.ERROR],
];

for (const [error, code, exit] of cases) {
  test(`translates ${code}`, () => {
    const t = translate(error, "ctx");
    assert.equal(t.code, code);
    assert.equal(t.exit, exit);
    assert.match(t.message, /^ctx: /);
    if (code !== "ERROR") {
      assert.ok(t.why, "has a cause");
      assert.ok(t.hint, "has a next step");
    }
  });
}

test("CliErrors pass through untouched", () => {
  const e = new CliError({ code: "X", exit: EXIT.REFUSED, message: "m" });
  assert.equal(translate(e), e);
});

test("JSON form carries code, cause and hint", () => {
  const j = translate(new HttpError(504, "late")).toJSON();
  assert.equal(j.code, "GATEWAY_TIMEOUT");
  assert.equal(j.status, 504);
  assert.match(j.hint!, /workflow show/);
});

test("every translation code is unique, and the guide lists them all", () => {
  const codes = TRANSLATIONS.map((t) => t.code);
  assert.equal(new Set(codes).size, codes.length);
  const table = errorTable();
  for (const c of [...codes, "EMPTY_MODEL", "NOT_EXECUTED", "REFUSED"]) assert.ok(table.includes(`**${c}**`), c);
});

test("node message hints", () => {
  assert.match(nodeMessageHint('Error in snippet: unexpected token "~"')!, /return/);
  assert.match(nodeMessageHint("No column spec available")!, /upstream/);
  assert.match(nodeMessageHint("Execute failed: Index 16512 out of bounds for length 16512")!, /alphaFraction/);
  assert.equal(nodeMessageHint("Index 3 out of bounds for length 7"), undefined);
  assert.equal(nodeMessageHint("all good"), undefined);
});
