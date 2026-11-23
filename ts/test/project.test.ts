/**
 * A project's unsaved changes and saving it: /api/project/state, /api/project/save, and the `dirty` flags in
 * /api/projects and /api/workflow/state.
 *
 * The API can't open a scratch project, so the save test saves the fixture project itself (KNIME_project unless
 * KNIME_CLI_PROJECT says otherwise). It only saves after its own node has been undone again, so what gets written is
 * the workflow as the suite found it, plus any unsaved edits made in the UI before the run, which are saved too.
 */
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import type { ProjectState, Projects, WorkflowState } from "./helpers/types.ts";
import { FACTORIES, WorkflowBuilder } from "./helpers/workflow.ts";

const fx: Fixture = await connect();
let wf: WorkflowBuilder | undefined;

after(async () => {
  await wf?.teardown();
});

function state(): Promise<ProjectState> {
  return fx.client.api<ProjectState>("/api/project/state", { projectId: fx.target.projectId });
}

async function mtimeMs(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

describe("/api/project/state", () => {
  test("describes the fixture project", async () => {
    const s = await state();
    assert.equal(s.projectId, fx.target.projectId);
    assert.equal(s.name, fx.projectName);
    assert.equal(typeof s.dirty, "boolean");
    assert.equal(typeof s.path, "string", "a local project has a directory");
    assert.equal(s.canSave, true, `the fixture project should be savable: ${s.saveBlocked}`);
    assert.equal(s.saveBlocked, undefined);
    assert.equal(s.saved, undefined);
  });

  test("agrees with workflow/state and projects", async () => {
    const [s, ws, { projects }] = await Promise.all([
      state(),
      fx.client.api<WorkflowState>("/api/workflow/state", fx.target),
      fx.client.api<Projects>("/api/projects"),
    ]);
    assert.equal(ws.dirty, s.dirty);
    assert.equal(projects.find((p) => p.projectId === s.projectId)?.dirty, s.dirty);
  });

  test("rejects an unknown project, a missing id and unknown fields", async () => {
    await expectHttpError(fx.client.api("/api/project/state", { projectId: "no-such-project" }), 404, "no-such-project");
    await expectHttpError(fx.client.api("/api/project/state", {}), 400, "projectId is required");
    await expectHttpError(
      fx.client.api("/api/project/state", { projectId: fx.target.projectId, workflowId: "root" }),
      400,
      "Unknown field 'workflowId'",
    );
  });
});

describe("/api/project/save", () => {
  test("refuses an unknown project", async () => {
    await expectHttpError(fx.client.api("/api/project/save", { projectId: "no-such-project" }), 404, "no-such-project");
  });

  test("an edit makes the project dirty, and saving makes it clean again", async () => {
    wf = new WorkflowBuilder(fx);
    await wf.addNode(FACTORIES.TABLE_CREATOR);
    assert.equal((await state()).dirty, true, "adding a node is an unsaved change");
    await wf.teardown();
    // Undoing doesn't make a project clean: KNIME doesn't track whether it's back to what was saved.
    const dirty = await state();
    assert.equal(dirty.dirty, true);
    assert.ok(dirty.path);

    const started = Date.now();
    const saved = await fx.client.api<ProjectState>("/api/project/save", { projectId: fx.target.projectId });
    assert.equal(saved.saved, true);
    assert.equal(saved.dirty, false);
    assert.equal(saved.path, dirty.path, "saved in place, never elsewhere");
    assert.equal(saved.executing, undefined);

    const clean = await state();
    assert.equal(clean.dirty, false);
    assert.equal(clean.saved, undefined, "only the save response says saved");
    assert.equal((await fx.client.api<WorkflowState>("/api/workflow/state", fx.target)).dirty, false);

    // Written to the project's own directory, and the UI's save hook redrew the workflow preview alongside it.
    // File times can lag the clock slightly, hence the margin.
    for (const file of ["workflow.knime", "workflow.svg"]) {
      assert.ok((await mtimeMs(join(dirty.path, file))) >= started - 2_000, `${file} was rewritten`);
    }
  });

  test("saving a clean project succeeds and leaves it clean", async () => {
    const saved = await fx.client.api<ProjectState>("/api/project/save", { projectId: fx.target.projectId });
    assert.equal(saved.dirty, false);
    assert.equal(saved.saved, true);
  });
});
