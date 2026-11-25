import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { main, type Io } from "../cli.ts";
import { COMMANDS } from "../commands/index.ts";
import { extensionFor, generateImagePath, imageSize } from "../commands/image.ts";
import { EXIT } from "../errors.ts";
import { FakeKnime } from "./fake.ts";

const BAR = "org.knime.base.views.node.barchart.BarChartNodeFactory";
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knime-cli-image-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function knime(k: FakeKnime, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), connect: async () => k.session() };
  const code = await main(COMMANDS, argv, io);
  return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

/** A CSV Reader feeding a Bar Chart whose image generation is off and whose Output Image port doesn't exist yet. */
function charted(): FakeKnime {
  const k = new FakeKnime();
  const reader = k.add({ factory: "org.knime.base.node.io.filehandling.csv.reader.CSVTableReaderNodeFactory", label: "t:csv", inPorts: 1 });
  const chart = k.add({
    factory: BAR, label: "t:bar", inPorts: 2, outPorts: 1,
    model: { generateImage: false, imageFormat: "SVG", width: 800, height: 600, categoryColumnV3: "city" },
  });
  k.connect(reader.id, 1, chart.id, 1);
  return k;
}

test("helpers: extension from content type, PNG and SVG sizes, the generateImage path", () => {
  assert.equal(extensionFor("image/svg+xml; charset=utf-8"), ".svg");
  assert.equal(extensionFor("image/png"), ".png");
  const png = Buffer.alloc(24);
  png.writeUInt32BE(400, 16);
  png.writeUInt32BE(300, 20);
  assert.deepEqual(imageSize("image/png", png), { width: 400, height: 300 });
  assert.deepEqual(imageSize("image/svg+xml", Buffer.from('<svg width="10" height="20">')), { width: 10, height: 20 });
  assert.equal(generateImagePath({ a: 1, generateImage: false }), "generateImage");
  assert.equal(generateImagePath({ view: { generateImage: true } }), "view.generateImage");
  assert.equal(generateImagePath({ a: 1 }), undefined);
});

test("without an image port: exit 3, and the hint points a chart node at --enable", async () => {
  const r = await knime(charted(), "node", "image", "t:bar", "--json");
  assert.equal(r.code, EXIT.NOT_FOUND);
  assert.equal(r.json.error.code, "NO_IMAGE_PORT");
  assert.match(r.json.error.hint, /--enable/);
});

test("--enable adds the port once, sets the image settings, runs the node and writes the file", async () => {
  const k = charted();
  const file = join(dir, "bar.png");
  const r = await knime(k, "node", "image", "t:bar", "--enable", "--width", "400", "--height", "300", "-o", file, "--json");
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.data.port, 1);
  assert.equal(r.json.data.width, 400);
  assert.equal(r.json.data.enabled.portAdded, true);
  assert.equal(k.commands("add_port").length, 1);
  assert.deepEqual(k.commands("add_port")[0], {
    kind: "add_port", nodeId: "root:2", side: "output", portGroup: "Output Image", portTypeId: "org.knime.core.node.port.image.ImagePortObject",
  });
  const chart = k.nodes.get("root:2")!;
  assert.equal(chart.model.generateImage, true);
  assert.equal(chart.model.imageFormat, "PNG", "-o *.png picks the format");
  assert.equal(chart.state, "EXECUTED");
  assert.deepEqual([...(await readFile(file)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(r.json.dirty, true, "an EXEC command reports unsaved changes");

  const again = await knime(k, "node", "image", "t:bar", "--enable", "-o", file, "--json");
  assert.equal(again.code, 0);
  assert.equal(k.commands("add_port").length, 1, "the port isn't added twice");
  assert.equal(again.json.data.enabled.changed, false);
  assert.equal(again.json.data.enabled.ran, false);
});

test("the default file name comes from the label and the content type", async () => {
  const k = charted();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const r = await knime(k, "node", "image", "t:bar", "--enable", "--format", "svg", "--json");
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.data.file, join(await import("node:fs").then((f) => f.realpathSync(dir)), "t-bar.svg"));
    assert.match(await readFile(join(dir, "t-bar.svg"), "utf8"), /^<svg/);
  } finally {
    process.chdir(cwd);
  }
});

test("a node without generateImage can't be enabled (exit 7); option errors are usage errors", async () => {
  const k = charted();
  const r = await knime(k, "node", "image", "t:csv", "--enable", "--json");
  assert.equal(r.code, EXIT.REJECTED);
  assert.equal(r.json.error.code, "NO_IMAGE_SETTING");
  assert.equal((await knime(k, "node", "image", "t:bar", "--format", "PNG")).code, EXIT.USAGE);
  assert.equal((await knime(k, "node", "image", "t:bar", "--enable", "--format", "gif")).code, EXIT.USAGE);
});

test("an image port before the node ran: IMAGE_NOT_READY (exit 8)", async () => {
  const k = charted();
  const chart = k.nodes.get("root:2")!;
  chart.imagePorts = [1];
  chart.outPorts = 2;
  const r = await knime(k, "node", "image", "t:bar", "--json");
  assert.equal(r.code, EXIT.INCOMPLETE);
  assert.equal(r.json.error.code, "IMAGE_NOT_READY");
});

test("nodes info tells how to get a chart node's image", async () => {
  const r = await knime(new FakeKnime(), "nodes", "info", "bar-chart", "--json");
  assert.equal(r.json.data.image, true);
  const text = await knime(new FakeKnime(), "nodes", "info", "bar-chart");
  assert.match(text.stdout, /knime node image <node> --enable/);
});
