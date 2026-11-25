import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { main, type Io } from "../cli.ts";
import { COMMANDS } from "../commands/index.ts";
import { EXIT } from "../errors.ts";
import { findBrowser, isPng, svgSize, svgToPng } from "../render.ts";
import { FakeKnime } from "./fake.ts";

let dir: string;
let browser: string;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "knime-cli-render-"));
  // A stand-in for headless Chrome: writes a PNG where --screenshot= says, and records its arguments.
  browser = join(dir, "fake-chrome");
  await writeFile(browser, `#!/usr/bin/env node
const fs = require("node:fs");
const shot = process.argv.find((a) => a.startsWith("--screenshot="));
fs.writeFileSync(${JSON.stringify(join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(shot.slice("--screenshot=".length), Buffer.from(${JSON.stringify([...PNG])}));
process.exit(1); // like Chrome, which can exit non-zero after writing the screenshot
`);
  await chmod(browser, 0o755);
});

after(async () => {
  delete process.env.KNIME_CLI_BROWSER;
  await rm(dir, { recursive: true, force: true });
});

async function knime(k: FakeKnime, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), connect: async () => k.session() };
  const code = await main(COMMANDS, argv, io);
  return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

test("svgSize reads width and height, else the viewBox", () => {
  assert.deepEqual(svgSize('<?xml version="1.0"?><svg xmlns="x" width="350" height="130.5" viewBox="2746 2941 350 131">'), { width: 350, height: 131 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 40 30">'), { width: 40, height: 30 });
  assert.equal(svgSize("<html>"), undefined);
});

test("KNIME_CLI_BROWSER wins; a path with playwright in it is the Playwright CLI", () => {
  assert.deepEqual(findBrowser({ KNIME_CLI_BROWSER: "/x/chrome" }), { kind: "chrome", path: "/x/chrome" });
  assert.equal(findBrowser({ KNIME_CLI_BROWSER: "/usr/local/bin/playwright" })?.kind, "playwright");
});

test("svgToPng sizes the window from the SVG and tolerates a non-zero exit once the PNG exists", async () => {
  const png = await svgToPng('<svg width="300" height="120"></svg>', { scale: 2, browser: { kind: "chrome", path: browser } });
  assert.ok(isPng(png));
  const args: string[] = JSON.parse(await readFile(join(dir, "args.json"), "utf8"));
  assert.ok(args.includes("--window-size=300,120"), args.join(" "));
  assert.ok(args.includes("--force-device-scale-factor=2"));
  assert.ok(args.includes("--headless"));
});

test("workflow svg prints the SVG on stdout, or writes -o", async () => {
  const k = new FakeKnime();
  const r = await knime(k, "workflow", "svg");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^<svg .*<\/svg>$/);
  const file = join(dir, "canvas.svg");
  const w = await knime(k, "workflow", "svg", "-o", file, "--json");
  assert.equal(w.json.data.file, file);
  assert.equal(w.json.data.width, 300);
  assert.match(await readFile(file, "utf8"), /^<svg/);
});

test("workflow svg --png renders through the browser; without -o it's a usage error", async () => {
  process.env.KNIME_CLI_BROWSER = browser;
  const k = new FakeKnime();
  assert.equal((await knime(k, "workflow", "svg", "--png")).code, EXIT.USAGE);
  const file = join(dir, "canvas.png");
  const r = await knime(k, "workflow", "svg", "-o", file, "--json");
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.data.contentType, "image/png");
  assert.ok(isPng(await readFile(file)));
});

test("workflow svg fails clearly when the plugin lacks the renderer (exit 4)", async () => {
  const k = new FakeKnime();
  k.capabilities.workflowSvg = false;
  const r = await knime(k, "workflow", "svg", "--json");
  assert.equal(r.code, EXIT.UNAVAILABLE);
  assert.equal(r.json.error.code, "CAPABILITY_MISSING");
  assert.match(r.json.error.message, /workflowSvg not found/);
  assert.ok(!k.calls.some((c) => c.method === "/api/workflow/svg"));
});
