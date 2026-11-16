/**
 * Node settings read/write: /api/node/settings and /api/node/settings/set. Uses a Wait node (ints, a string), a Column
 * Filter (strings, booleans, string arrays, nested groups), a Regression Tree Learner (null values, an incomplete read,
 * typed values), a metanode made by collapsing a node, a slow Wait chain for the 409 case, and a node with a password
 * for redaction. Each test that changes settings restores them; teardown removes the nodes regardless.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import { rawPost } from "./helpers/raw.ts";
import type { ExecResult, Json, JsonObject, SetResult, Settings, WorkflowState } from "./helpers/types.ts";
import { FACTORIES, nodeStatus, SECRET_CANDIDATES, waitForNode, WorkflowBuilder } from "./helpers/workflow.ts";

// Top-level, so a missing KNIME fails the file once with a clear message instead of failing every test.
const fx: Fixture = await connect();
let wf: WorkflowBuilder;
let wait: string;
let cf: string;

before(async () => {
  wf = new WorkflowBuilder(fx);
  wait = await wf.addNode(FACTORIES.WAIT);
  // The Column Filter only creates (and saves) its configuration once it has been configured with an input spec, so
  // it needs a table upstream; unconnected, its model settings are empty.
  const tc = await wf.addNode(FACTORIES.TABLE_CREATOR, 1);
  cf = await wf.addNode(FACTORIES.COLUMN_FILTER, 1);
  await wf.connect(tc, 1, cf, 1);
});

after(async () => {
  await wf?.teardown();
});

function getSettings(nodeId: string, workflowId = fx.target.workflowId): Promise<Settings> {
  return fx.client.api<Settings>("/api/node/settings", { ...fx.target, workflowId, nodeId });
}
function setSettings(nodeId: string, model: unknown): Promise<SetResult> {
  return fx.client.api<SetResult>("/api/node/settings/set", { ...fx.target, nodeId, model });
}
/** Sends `modelJson` verbatim, for bodies JSON.stringify can't produce (e.g. `1.0`). */
async function setRawModel(nodeId: string, modelJson: string): Promise<{ status: number; error: string }> {
  const head = JSON.stringify({ ...fx.target, nodeId });
  const res = await rawPost(fx.instance, "/api/node/settings/set", `${head.slice(0, -1)},"model":${modelJson}}`);
  return { status: res.status, error: (res.json as { error?: string } | undefined)?.error ?? res.text };
}
function execute(nodeIds: string[], waitMs = 30_000): Promise<ExecResult> {
  return fx.client.api<ExecResult>("/api/execute", { ...fx.target, nodeIds, waitMs });
}

function isObject(v: Json | undefined): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** The object at `key`, failing with the keys that do exist (the settings layout is the node's, not ours). */
function group(parent: JsonObject, key: string): JsonObject {
  const v = parent[key];
  assert.ok(isObject(v), `expected settings group "${key}"; have: ${Object.keys(parent).join(", ")}`);
  return v;
}
function leaf<T extends Json>(parent: JsonObject, key: string, type: "number" | "string" | "boolean"): T {
  const v = parent[key];
  assert.equal(typeof v, type, `expected ${type} setting "${key}", got ${JSON.stringify(v)}; have: ${Object.keys(parent).join(", ")}`);
  return v as T;
}

/** RFC 6901 pointer -> path segments. */
function segments(pointer: string): string[] {
  return pointer.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}
function at(root: Json, path: string[]): Json | undefined {
  let cur: Json | undefined = root;
  for (const s of path) {
    if (Array.isArray(cur)) cur = cur[Number(s)];
    else if (isObject(cur)) cur = cur[s];
    else return undefined;
  }
  return cur;
}
/** A model patch that sets the leaf at `/model/...` to `value`. */
function patchAt(pointer: string, value: Json): JsonObject {
  const path = segments(pointer);
  assert.equal(path[0], "model", pointer);
  let patch: Json = value;
  for (const s of path.slice(1).reverse()) patch = { [s]: patch };
  return patch as JsonObject;
}

const REDACTED = { $redacted: true };
/** Mirrors Secrets.SECRET_NAME / CREDENTIAL_NAME_KEYS: leaf names the server must always redact. */
const SECRET_NAME = /password|passwd|pwd|secret|token|apikey|api_key|private_?key|passphrase|weaklyencrypted|transient/i;
const CREDENTIAL_NAME_KEYS = new Set(["credentials", "credential_name", "credentialName", "name"]);

describe("read", () => {
  test("Wait node: kind, model and variables", async () => {
    const s = await getSettings(wait);
    assert.equal(s.nodeId, wait);
    assert.equal(s.kind, "native");
    assert.ok(isObject(s.model));
    assert.ok(isObject(s.variables), "variables is an object even without bindings");
    assert.deepEqual(s.redacted, []);
    // Defaults from SleepNodeParameters: wait for a duration (ordinal 0) of 1 s.
    assert.equal(leaf(s.model, "wait_option", "number"), 0);
    assert.equal(leaf(s.model, "for_seconds", "number"), 1);
    leaf(s.model, "for_minutes", "number");
    // The file-mode keys (path_to_file, file_status_to_observe) are only saved once file mode is chosen.
  });

  test("Column Filter: nested groups, string arrays and booleans", async () => {
    const s = await getSettings(cf);
    assert.equal(s.kind, "native");
    const filter = group(s.model, "column-filter");
    assert.ok(Array.isArray(filter.included_names), "KNIME arrays come back as JSON arrays");
    assert.ok(Array.isArray(filter.excluded_names));
    leaf(filter, "filter-type", "string");
    leaf(group(filter, "name_pattern"), "caseSensitive", "boolean");
    leaf(group(filter, "name_pattern"), "pattern", "string");
  });

  test("reading settings changes nothing", async () => {
    const a = await getSettings(wait);
    const b = await getSettings(wait);
    assert.deepEqual(a, b);
  });

  test("unknown nodeId -> 404; malformed -> 400; missing -> 400", async () => {
    await expectHttpError(getSettings("root:99999"), 404);
    await expectHttpError(getSettings("root:x"), 400, "nodeId");
    await expectHttpError(fx.client.api("/api/node/settings", fx.target), 400, "nodeId is required");
  });
});

describe("write", () => {
  test("a change applies, shows in GET and resets an executed node; the same patch again is a no-op", { timeout: 60_000 }, async (t) => {
    t.after(() => setSettings(wait, { for_seconds: 1 }));

    const ran = await execute([wait]);
    assert.equal(ran.states[wait], "EXECUTED");

    const set = await setSettings(wait, { for_seconds: 2 });
    assert.equal(set.changed, true);
    assert.equal(set.nodeId, wait);
    assert.equal(set.state, "CONFIGURED", "loading new settings resets the node");
    assert.equal(set.model.for_seconds, 2);
    assert.deepEqual(set.redacted, []);
    assert.equal(set.message, undefined);
    assert.equal((await getSettings(wait)).model.for_seconds, 2);
    assert.equal((await nodeStatus(fx.client, fx.target, wait)).state, "CONFIGURED");

    const ranAgain = await execute([wait]);
    assert.equal(ranAgain.states[wait], "EXECUTED");
    const same = await setSettings(wait, { for_seconds: 2 });
    assert.equal(same.changed, false);
    assert.equal(same.state, "EXECUTED", "a no-op keeps the results");
    assert.equal((await nodeStatus(fx.client, fx.target, wait)).state, "EXECUTED");

    const sameTwoKeys = await setSettings(wait, { for_seconds: 2, for_minutes: 0 });
    assert.equal(sameTwoKeys.changed, false);
  });

  test("only the patched keys change", async (t) => {
    const before = await getSettings(wait);
    t.after(() => setSettings(wait, { for_minutes: before.model.for_minutes }));
    await setSettings(wait, { for_minutes: 3 });
    const now = await getSettings(wait);
    assert.deepEqual({ ...now.model, for_minutes: before.model.for_minutes }, before.model);
    assert.deepEqual(Object.keys(now.model), Object.keys(before.model), "key order is kept");
  });

  test("strings, booleans, string arrays and nested groups", async (t) => {
    const original = group((await getSettings(cf)).model, "column-filter");
    const pattern = group(original, "name_pattern");
    t.after(() =>
      setSettings(cf, {
        "column-filter": {
          included_names: original.included_names,
          name_pattern: { caseSensitive: pattern.caseSensitive, pattern: pattern.pattern },
        },
      }),
    );

    const flipped = !pattern.caseSensitive;
    const set = await setSettings(cf, {
      "column-filter": {
        included_names: ["knime-cli-a", "knime-cli-b"],
        name_pattern: { caseSensitive: flipped, pattern: "knime-cli*" },
      },
    });
    assert.equal(set.changed, true);
    const now = group((await getSettings(cf)).model, "column-filter");
    assert.deepEqual(now.included_names, ["knime-cli-a", "knime-cli-b"]);
    assert.equal(group(now, "name_pattern").caseSensitive, flipped);
    assert.equal(group(now, "name_pattern").pattern, "knime-cli*");
    assert.deepEqual(now.excluded_names, original.excluded_names, "siblings untouched");

    const emptied = await setSettings(cf, { "column-filter": { included_names: [] } });
    assert.equal(emptied.changed, true);
    assert.deepEqual(group((await getSettings(cf)).model, "column-filter").included_names, []);
  });

  test("unknown nodeId -> 404", async () => {
    await expectHttpError(setSettings("root:99999", { for_seconds: 1 }), 404);
  });
});

describe("rejected patches (400, nothing changes)", () => {
  test("unknown key names the JSON pointer", async () => {
    await expectHttpError(setSettings(wait, { nope: 1 }), 400, "/model/nope", "for_seconds");
    await expectHttpError(setSettings(cf, { "column-filter": { nope: true } }), 400, "/model/column-filter/nope");
  });

  test("wrong types for an int", async () => {
    await expectHttpError(setSettings(wait, { for_seconds: "3" }), 400, "/model/for_seconds", "integer");
    await expectHttpError(setSettings(wait, { for_seconds: 1.5 }), 400, "/model/for_seconds");
    await expectHttpError(setSettings(wait, { for_seconds: true }), 400, "/model/for_seconds");
    await expectHttpError(setSettings(wait, { for_seconds: null }), 400, "/model/for_seconds");
    await expectHttpError(setSettings(wait, { for_seconds: 2 ** 31 }), 400, "/model/for_seconds");
    await expectHttpError(setSettings(wait, { for_seconds: [1] }), 400, "/model/for_seconds");
  });

  test("1.0 is not an int (strict, even though it is integral)", async () => {
    const res = await setRawModel(wait, '{"for_seconds":1.0}');
    assert.equal(res.status, 400, res.error);
    assert.match(res.error, /\/model\/for_seconds/);
  });

  test("wrong types for strings, booleans, arrays and groups", async () => {
    await expectHttpError(setSettings(wait, { path_to_file: 5 }), 400, "/model/path_to_file", "string");
    const p = "/model/column-filter";
    await expectHttpError(setSettings(cf, { "column-filter": { name_pattern: { caseSensitive: "true" } } }), 400, `${p}/name_pattern/caseSensitive`);
    await expectHttpError(setSettings(cf, { "column-filter": { included_names: "a" } }), 400, `${p}/included_names`, "list");
    await expectHttpError(setSettings(cf, { "column-filter": { included_names: [1] } }), 400, `${p}/included_names/0`);
    await expectHttpError(setSettings(cf, { "column-filter": { name_pattern: "x" } }), 400, `${p}/name_pattern`, "group");
    await expectHttpError(setSettings(cf, { "column-filter": "x" }), 400, p);
  });

  test("a redacted placeholder can't be written back", async () => {
    await expectHttpError(setSettings(wait, { for_seconds: REDACTED }), 400, "/model/for_seconds", "redacted");
    await expectHttpError(
      setSettings(cf, { "column-filter": { included_names: [REDACTED] } }),
      400,
      "/model/column-filter/included_names/0",
    );
  });

  test("empty, missing or non-object model", async () => {
    await expectHttpError(setSettings(wait, {}), 400, "model must be a non-empty JSON object");
    await expectHttpError(fx.client.api("/api/node/settings/set", { ...fx.target, nodeId: wait }), 400, "model");
    await expectHttpError(setSettings(wait, []), 400, "model");
    await expectHttpError(setSettings(wait, "for_seconds=2"), 400, "model");
  });

  test("all-or-nothing: one bad key rejects the whole patch", async () => {
    const before = await getSettings(wait);
    await expectHttpError(setSettings(wait, { for_minutes: 7, nope: 1 }), 400, "/model/nope");
    await expectHttpError(setSettings(wait, { for_minutes: 7, for_seconds: "x" }), 400, "/model/for_seconds");
    assert.deepEqual((await getSettings(wait)).model, before.model);
  });
});

describe("null values, incomplete reads and typed values", () => {
  let tree: string;

  before(async () => {
    tree = await wf.addNode(FACTORIES.REGRESSION_TREE, 4);
  });

  test("settings that hold null come back as null, not left out", async () => {
    const s = await getSettings(tree);
    assert.ok("targetColumn" in s.model, `targetColumn is listed; have: ${Object.keys(s.model).join(", ")}`);
    assert.equal(s.model.targetColumn, null);
    assert.equal(s.model.hardCodedRootColumn, null);
  });
});

describe("metanodes", () => {
  test("a metanode has no settings of its own -> 400", { timeout: 60_000 }, async (t) => {
    const node = await wf.addNode(FACTORIES.WAIT, 1);
    let meta: string;
    try {
      meta = await wf.collapse([node]);
    } catch (e) {
      t.skip(`collapse command failed, so no metanode to test with: ${String(e)}`);
      return;
    }
    try {
      await expectHttpError(getSettings(meta), 400, "metanode");
      await expectHttpError(setSettings(meta, { for_seconds: 2 }), 400, "metanode");

      // The node inside is reachable by passing the metanode as workflowId.
      const inner = await fx.client.api<WorkflowState>("/api/workflow/state", { ...fx.target, workflowId: meta });
      const innerId = inner.nodes[0]?.nodeId;
      assert.ok(innerId, "metanode contains our node");
      const s = await getSettings(innerId, meta);
      assert.equal(s.kind, "native");
      assert.equal(s.model.for_seconds, 1);
    } finally {
      await wf.undo(); // expand again, so the add underneath can be undone by teardown
    }
    const state = await fx.client.api<WorkflowState>("/api/workflow/state", fx.target);
    assert.ok(state.nodes.some((n) => n.nodeId === node), `${node} is back after undoing the collapse`);
    assert.ok(!state.nodes.some((n) => n.nodeId === meta), "metanode gone");
  });
});

describe("busy nodes", () => {
  test("setting a node whose successor is executing -> 409", { timeout: 90_000 }, async (t) => {
    const first = await wf.addNode(FACTORIES.WAIT, 2);
    const second = await wf.addNode(FACTORIES.WAIT, 2);
    await wf.connect(first, 1, second, 1);
    await setSettings(second, { for_seconds: 30 });
    t.after(async () => {
      await fx.client.api("/api/cancel", { ...fx.target, nodeIds: [first, second] });
      await fx.client.api("/api/wait", { ...fx.target, nodeIds: [first, second], waitMs: 30_000 });
      await setSettings(second, { for_seconds: 1 });
    });

    await execute([second], 0);
    await waitForNode(fx.client, fx.target, second, (s) => s.state === "EXECUTING", 15_000);

    await expectHttpError(setSettings(first, { for_seconds: 2 }), 409, first, "successor");
    await expectHttpError(setSettings(second, { for_seconds: 2 }), 409, second);
    // A no-op isn't a load, so it's answered even while busy.
    const noop = await setSettings(first, { for_seconds: 1 });
    assert.equal(noop.changed, false);
    assert.equal(noop.state, "EXECUTED");
    // Reading is always fine.
    assert.equal((await getSettings(second)).model.for_seconds, 30);
    assert.equal((await getSettings(first)).model.for_seconds, 1, "the refused change wasn't applied");
  });
});

describe("secrets", () => {
  test("passwords are redacted on the way out and refused on the way in", { timeout: 60_000 }, async (t) => {
    let node: string | undefined;
    let settings: Settings | undefined;
    const tried: string[] = [];
    for (const factory of SECRET_CANDIDATES) {
      let id: string;
      try {
        id = await wf.addNode(factory, 3);
      } catch (e) {
        tried.push(`${factory}: add failed (${String(e)})`);
        continue;
      }
      const s = await getSettings(id);
      if (s.redacted.length) {
        node = id;
        settings = s;
        break;
      }
      tried.push(`${factory}: no redacted settings`);
      await wf.undo();
    }
    if (!node || !settings) {
      t.skip(`no installed node with a password in its default settings: ${tried.join("; ")}`);
      return;
    }

    // Every listed pointer is a placeholder, under model or variables.
    for (const pointer of settings.redacted) {
      assert.match(pointer, /^\/(model|variables)\//);
      assert.deepEqual(at(settings as unknown as Json, segments(pointer)), REDACTED, pointer);
    }

    // And nothing secret-looking slipped through anywhere in the raw body.
    const res = await rawPost(fx.instance, "/api/node/settings", { ...fx.target, nodeId: node });
    assert.equal(res.status, 200);
    const walk = (v: Json, path: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}/${i}`));
      else if (isObject(v)) {
        if (v.$redacted === true) return;
        for (const [k, x] of Object.entries(v)) {
          const p = `${path}/${k}`;
          if (!isObject(x) && !Array.isArray(x) && SECRET_NAME.test(k) && !CREDENTIAL_NAME_KEYS.has(k)) {
            assert.fail(`${p} looks secret but came back as ${JSON.stringify(x)}`);
          }
          walk(x, p);
        }
      }
    };
    const body = res.json as Settings;
    walk(body.model, "/model");
    walk(body.variables, "/variables");
    assert.doesNotMatch(res.text, /"(transient\w*|weaklyEncrypted\w*|passwordEncrypted)"\s*:\s*"/);

    // Patching a secret is refused, whether with a value or with the placeholder.
    const target = settings.redacted.find((p) => p.startsWith("/model/"));
    assert.ok(target, `a redacted model setting: ${settings.redacted.join(", ")}`);
    // The error names the secret, or the protected config (e.g. a Credentials widget) it sits in.
    const namesTargetOrAncestor = (message: string) =>
      segments(target).some((_, i, all) => message.includes("/" + all.slice(0, i + 1).join("/") + " "));
    for (const value of ["knime-cli-test", REDACTED] as Json[]) {
      const e = await expectHttpError(setSettings(node, patchAt(target, value)), 400);
      assert.ok(namesTargetOrAncestor(e.message), `error should name ${target} or a parent: ${e.message}`);
      assert.doesNotMatch(e.message, /knime-cli-test/, "the rejected value isn't echoed");
    }

    // A Credentials widget config is protected as a whole, public keys included.
    const parent = segments(target).slice(0, -1);
    const parentValue = at(settings as unknown as Json, parent);
    if (isObject(parentValue) && "isCredentials_Internals" in parentValue && "login" in parentValue) {
      const loginPointer = "/" + [...parent, "login"].map((s) => s.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
      await expectHttpError(setSettings(node, patchAt(loginPointer, "someone-else")), 400);
    }

    assert.deepEqual((await getSettings(node)).model, settings.model, "refused patches changed nothing");
  });
});
