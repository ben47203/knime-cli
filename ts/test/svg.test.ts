/**
 * The workflow canvas as SVG: /api/workflow/svg. Adds a Table Creator and a Wait node, collapses the Wait node into a
 * metanode, and removes them all again in after().
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import { rawPost } from "./helpers/raw.ts";
import { FACTORIES, WorkflowBuilder } from "./helpers/workflow.ts";

const fx: Fixture = await connect();
let wf: WorkflowBuilder;
let tc: string;
let metanode: string;

before(async () => {
  wf = new WorkflowBuilder(fx);
  tc = await wf.addNode(FACTORIES.TABLE_CREATOR);
  const wait = await wf.addNode(FACTORIES.WAIT, 1);
  metanode = await wf.collapse([wait]);
});

after(async () => {
  await wf?.teardown();
});

async function svg(workflowId = "root"): Promise<string> {
  const { contentType, bytes } = await fx.client.apiBytes("/api/workflow/svg", { ...fx.target, workflowId });
  assert.match(contentType, /^image\/svg\+xml\b/);
  const text = bytes.toString("utf8");
  assert.match(text, /^(<\?xml[^>]*\?>\s*)?<svg[\s>]/, "starts with an SVG root element");
  assert.match(text, /<\/svg>\s*$/, "is complete");
  return text;
}

describe("/api/workflow/svg", () => {
  test("draws the root workflow with its nodes' names", async () => {
    const text = await svg();
    assert.ok(text.includes("Table Creator"), `expected ${tc}'s name in the drawing`);
    assert.match(text, /viewBox="-?\d+ -?\d+ \d+ \d+"/);
  });

  test("draws a metanode's own workflow", async () => {
    const inner = await svg(metanode);
    assert.ok(inner.includes("Wait"), "the metanode holds the Wait node");
    assert.ok(!inner.includes("Table Creator"), "and nothing from the root");
  });

  test("the root defaults when workflowId is left out", async () => {
    const { bytes } = await fx.client.apiBytes("/api/workflow/svg", { projectId: fx.target.projectId });
    assert.ok(bytes.toString("utf8").includes("Table Creator"));
  });

  test("errors are JSON, not SVG", async () => {
    const res = await rawPost(fx.instance, "/api/workflow/svg", { projectId: "no-such-project" });
    assert.equal(res.status, 404);
    assert.match(String(res.headers["content-type"]), /^application\/json/);
    assert.deepEqual(Object.keys(res.json as object), ["error"]);
  });

  test("rejects a node that isn't a metanode or component, and a malformed id", async () => {
    await expectHttpError(fx.client.apiBytes("/api/workflow/svg", { ...fx.target, workflowId: tc }), 400);
    await expectHttpError(fx.client.apiBytes("/api/workflow/svg", { ...fx.target, workflowId: "garbage" }), 400);
  });
});
