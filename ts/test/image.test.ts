/**
 * Images from image output ports: /api/node/port/image, and image ports in /api/node/ports. Builds CSV Reader -> Bar
 * Chart with image generation on, runs it once for a PNG and once for an SVG, and removes both nodes in after().
 *
 * Needs the chart nodes, org.knime.base.views and org.knime.js.views, in the KNIME launch. A Bar Chart (like the other
 * modern view nodes, via ModelSettingsWithImageGeneration) only renders an image when its model setting
 * `generateImage` is true AND its "Output Image" port group has a port. The dialog's Apply adds that port when the
 * setting is switched on; node/settings/set doesn't, so the test adds it with the gateway's add_port command.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { connect, expectHttpError, type Fixture } from "./helpers/fixture.ts";
import type { ExecResult, NodePorts, SetResult } from "./helpers/types.ts";
import { WorkflowBuilder } from "./helpers/workflow.ts";

const CSV_READER = "org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory";
const BAR_CHART = "org.knime.base.views.node.barchart.BarChartNodeFactory";
const IMAGE_PORT_TYPE = "org.knime.core.node.port.image.ImagePortObject";
const CSV = "city,sales\nPerth,10\nHobart,7\nDarwin,4\nPerth,3\n";
const WIDTH = 400;
const HEIGHT = 300;

const fx: Fixture = await connect();
let wf: WorkflowBuilder;
let dir: string;
let reader: string;
let chart: string;
/** Index of the chart's image output port, as node/ports numbers it (0 is the flow-variable port). */
let imagePort: number;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knime-cli-image-"));
  const csv = join(dir, "sales.csv");
  await writeFile(csv, CSV);

  wf = new WorkflowBuilder(fx);
  reader = await wf.addNode(CSV_READER);
  await fx.client.api<SetResult>("/api/node/settings/set", {
    ...fx.target,
    nodeId: reader,
    model: { csvReaderParameters: { multiFileSelectionParams: { source: { path: { path: csv } } } } },
  });
  try {
    chart = await wf.addNode(BAR_CHART);
  } catch (e) {
    throw new Error(`Can't add a Bar Chart; does the KNIME launch include org.knime.base.views? ${String(e)}`);
  }
  await wf.connect(reader, 1, chart, 1);
  const added = await wf.command<{ newPortIdx: number }>({
    kind: "add_port",
    nodeId: chart,
    side: "output",
    portGroup: "Output Image",
    portTypeId: IMAGE_PORT_TYPE,
  });
  imagePort = added.newPortIdx;
  await setChart("PNG");
});

after(async () => {
  try {
    await wf?.teardown();
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function setChart(imageFormat: "PNG" | "SVG"): Promise<SetResult> {
  return fx.client.api<SetResult>("/api/node/settings/set", {
    ...fx.target,
    nodeId: chart,
    model: {
      generateImage: true,
      imageFormat,
      width: WIDTH,
      height: HEIGHT,
      categoryColumnV3: "city",
      aggregationMethod: "SUM",
      frequencyColumnsV2: {
        mode: "MANUAL",
        manualFilter: { manuallySelected: ["sales"], manuallyDeselected: [], includeUnknownColumns: false },
      },
    },
  });
}

async function run(nodeIds: string[]): Promise<void> {
  const res = await fx.client.api<ExecResult>("/api/execute", { ...fx.target, nodeIds, waitMs: 30_000 });
  assert.deepEqual(res.failed, [], `execution failed: ${JSON.stringify(res)}`);
  assert.equal(res.done, true);
}

function image(port = imagePort, nodeId = chart) {
  return fx.client.apiBytes("/api/node/port/image", { ...fx.target, nodeId, port });
}

async function imageSpec() {
  const { outputs } = await fx.client.api<NodePorts>("/api/node/ports", { ...fx.target, nodeId: chart });
  const port = outputs[imagePort];
  assert.ok(port, `expected output port ${imagePort}`);
  assert.equal(port.type, "Image");
  return port.spec;
}

describe("before the chart runs", () => {
  test("node/ports reports the image port and its format", async () => {
    await run([reader]); // so the chart configures and its image spec is known
    assert.deepEqual(await imageSpec(), { kind: "image", format: "png" });
  });

  test("there is no image yet", async () => {
    await expectHttpError(image(), 409, "holds no image until the node executes");
  });
});

describe("a PNG", () => {
  test("comes back as image/png with the configured size", async () => {
    await run([chart]);
    const { contentType, bytes } = await image();
    assert.equal(contentType, "image/png");
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
    assert.equal(bytes.readUInt32BE(16), WIDTH);
    assert.equal(bytes.readUInt32BE(20), HEIGHT);
  });
});

describe("an SVG", () => {
  test("comes back as image/svg+xml", async () => {
    await setChart("SVG"); // resets the chart
    assert.deepEqual(await imageSpec(), { kind: "image", format: "svg" });
    await expectHttpError(image(), 409, "holds no image");
    await run([chart]);
    const { contentType, bytes } = await image();
    assert.match(contentType, /^image\/svg\+xml\b/);
    const text = bytes.toString("utf8");
    assert.match(text, /<svg[\s>]/);
    assert.match(text, /<\/svg>\s*$/);
    assert.ok(text.includes("Perth"), "the chart's categories are drawn");
  });
});

describe("other ports", () => {
  test("a flow-variable or table port isn't an image port", async () => {
    await expectHttpError(image(0), 400, "Flow Variable port, not an image port");
    await expectHttpError(image(1, reader), 400, "Table port, not an image port");
  });

  test("a port the node doesn't have", async () => {
    await expectHttpError(image(imagePort + 1), 400, "has no output port");
    await expectHttpError(image(-1), 400, "has no output port");
  });

  test("port is required", async () => {
    await expectHttpError(fx.client.apiBytes("/api/node/port/image", { ...fx.target, nodeId: chart }), 400, "port is required");
  });
});
