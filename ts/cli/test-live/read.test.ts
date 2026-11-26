/** Live: the read-only and local commands, and the `knime` entry point itself as a subprocess. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import { EXIT } from "../errors.ts";
import { human, knime, skipReason } from "./live.ts";

const skip = await skipReason();

describe("read-only commands", { skip }, () => {
  test("status: ready, API v2, every capability present, and the project's save state", async () => {
    const r = await knime("status");
    assert.equal(r.code, 0, JSON.stringify(r.json.error));
    assert.equal(r.json.data.ready, true);
    assert.equal(r.json.data.apiVersion, 2);
    assert.deepEqual(r.json.data.capabilities, { settingsSaveCheck: true, saveRefreshesUi: true, workflowSvg: true });
    assert.equal(typeof r.json.data.project?.dirty, "boolean");
    assert.equal(r.json.dirty, undefined, "READ commands don't run the unsaved-changes check");
  });

  test("the knime entry point runs as a subprocess and exits with the command's code", async () => {
    const r = await promisify(execFile)(process.execPath, [new URL("../main.ts", import.meta.url).pathname, "status", "--json"], { env: process.env });
    assert.equal(JSON.parse(r.stdout).ok, true);
    await assert.rejects(promisify(execFile)(process.execPath, [new URL("../main.ts", import.meta.url).pathname, "node", "settings", "e2e:does-not-exist", "--json"]),
      (e: { code?: number; stdout?: string }) => e.code === EXIT.NOT_FOUND && JSON.parse(e.stdout ?? "{}").error?.code === "NODE_NOT_FOUND");
  });

  test("guide: the start topic, the topic list, and the saving and images topics", async () => {
    const r = await knime("guide");
    assert.equal(r.code, 0);
    const ids = r.json.data.topics.map((t: { id: string }) => t.id);
    for (const id of ["start", "saving", "images", "apply", "errors"]) assert.ok(ids.includes(id), id);
    const images = await knime("guide", "png");
    assert.match(images.json.data.body, /knime node image <chart> --enable/);
    assert.equal((await knime("guide", "no-such-topic")).code, EXIT.USAGE);
  });

  test("nodes search and info", async () => {
    const s = await knime("nodes", "search", "chart");
    assert.ok(s.json.data.results.some((e: { alias: string }) => e.alias === "bar-chart"));
    const rf = await knime("nodes", "info", "rf-learn");
    assert.equal(rf.json.data.alias, "rf-learn");
    assert.ok(rf.json.data.presets.some((p: { name: string }) => p.name === "regression"));
    assert.equal(rf.json.data.in, undefined, "ports come from node/ports, not the catalogue");
    const bar = await human("nodes", "info", "bar-chart");
    assert.match(bar.stdout, /knime node image <node> --enable/);
    assert.equal((await knime("nodes", "info", "no-such-alias")).code, EXIT.NOT_FOUND);
  });

  test("workflow show: the project, its save state and the nodes", async () => {
    const r = await knime("workflow", "show");
    assert.equal(r.code, 0);
    assert.equal(r.json.data.workflowId, "root");
    assert.equal(typeof r.json.data.project.name, "string");
    assert.equal(typeof r.json.data.project.canSave, "boolean");
    assert.ok(Array.isArray(r.json.data.nodes));
  });
});
