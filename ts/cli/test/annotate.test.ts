import assert from "node:assert/strict";
import { test } from "node:test";

import { RpcError } from "../../src/client.ts";
import { boundsAround, parseColour, PALETTE } from "../annotations.ts";
import { byAlias } from "../catalogue.ts";
import { main, type Io } from "../cli.ts";
import { COMMANDS } from "../commands/index.ts";
import { CliError, EXIT } from "../errors.ts";
import { FakeKnime } from "./fake.ts";

async function knime(k: FakeKnime, ...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const io: Io = { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), connect: async () => k.session() };
  const code = await main(COMMANDS, argv, io);
  return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

/** Two prep nodes, one model node, and someone else's untagged annotation. */
function workflow(): FakeKnime {
  const k = new FakeKnime();
  const f = byAlias("partition")!.factory;
  k.add({ factory: f, label: "my:prep-read", x: 100, y: 100 });
  k.add({ factory: f, label: "my:prep-split\nan 80/20 split", x: 300, y: 200 });
  k.add({ factory: f, label: "my:model", x: 600, y: 100 });
  k.annotate({ text: "Someone's notes", contentType: "text/plain", bounds: { x: 0, y: 600, width: 200, height: 80 } });
  return k;
}

test("colours: palette names, plain names and hex forms; anything else is BAD_COLOUR", () => {
  assert.equal(parseColour("Meadow"), PALETTE.Meadow);
  assert.equal(parseColour("silver-sand"), PALETTE.SilverSand);
  assert.equal(parseColour("green"), PALETTE.Meadow);
  assert.equal(parseColour("3cb44b"), "#3CB44B");
  assert.equal(parseColour("#fa0"), "#FFAA00");
  assert.throws(() => parseColour("chartreuse"), (e: CliError) => e.code === "BAD_COLOUR" && /Meadow/.test(e.hint!));
});

test("boundsAround encloses the icons, their labels and room for the text above", () => {
  const b = boundsAround([
    { id: "a", position: { x: 100, y: 100 }, label: "a" },
    { id: "b", position: { x: 300, y: 200 }, label: "b", note: "two\nlines" },
  ], 2);
  assert.ok(b.x < 100 - 32 && b.x + b.width > 300 + 32 + 32, "names overhang the icons sideways");
  assert.ok(b.y <= 100 - 50 - 2 * 20, "the text fits above the top node's name");
  assert.ok(b.y + b.height >= 200 + 32 + 3 * 16, "label and note lines fit below the bottom node");
});

test("annotate add --prefix fits a tagged, coloured box round the stage and returns its id", async () => {
  const k = workflow();
  const r = await knime(k, "annotate", "add", "--text", "Data prep\\nclean and split", "--colour", "meadow", "--tag", "my:prep", "--prefix", "my:prep-", "--json");
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.json.data.id, "root_1");
  assert.deepEqual(r.json.data.around, ["root:1", "root:2"]);
  const a = k.annotations.find((x) => x.id === "root_1")!;
  assert.equal(a.text?.value, "<p>Data prep</p><p>clean and split</p><p>[[my:prep]]</p>");
  assert.equal(a.borderColor, PALETTE.Meadow);
  const { x, y, width, height } = a.bounds;
  for (const n of [k.nodes.get("root:1")!, k.nodes.get("root:2")!]) assert.ok(n.x > x && n.x + 32 < x + width && n.y > y && n.y + 32 < y + height);
  assert.ok(k.nodes.get("root:3")!.x > x + width, "the model node stays outside");
});

test("annotate add --around takes ids and labels, comma-separated or repeated", async () => {
  const k = workflow();
  const r = await knime(k, "annotate", "add", "--around", "my:prep-read,3", "--around", "my:model", "--tag", "my:all", "--json");
  assert.deepEqual(r.json.data.around, ["root:1", "root:3"]);
  assert.equal(k.annotations.at(-1)!.text?.value, "<p>[[my:all]]</p>");
});

test("annotate add needs one placement and a valid colour, and sends nothing otherwise", async () => {
  const k = workflow();
  assert.equal((await knime(k, "annotate", "add", "--text", "x")).code, EXIT.USAGE);
  assert.equal((await knime(k, "annotate", "add", "--bounds", "1,2,3,4", "--around", "my:model")).code, EXIT.USAGE);
  assert.equal((await knime(k, "annotate", "add", "--bounds", "1,2,0,4")).code, EXIT.USAGE);
  const bad = await knime(k, "annotate", "add", "--bounds", "1,2,3,4", "--colour", "chartreuse", "--json");
  assert.equal(bad.json.error.code, "BAD_COLOUR");
  assert.equal((await knime(k, "annotate", "add", "--prefix", "nobody:")).code, EXIT.NOT_FOUND);
  assert.equal(k.commands().length, 0);
});

test("annotate add warns without a tag, and removes the box if its text can't be written", async () => {
  const k = workflow();
  const untagged = await knime(k, "annotate", "add", "--bounds", "0,0,50,50", "--json");
  assert.match(untagged.json.warnings.join(" "), /no --tag/);
  const call = k.call.bind(k);
  k.call = async (method, params) => {
    if ((params?.workflowCommand as { kind?: string })?.kind === "update_workflow_annotation") throw new RpcError(-32600, "boom", null);
    return call(method, params);
  };
  const before = k.annotations.length;
  assert.equal((await knime(k, "annotate", "add", "--text", "x", "--bounds", "0,0,50,50")).code, EXIT.REJECTED);
  assert.equal(k.annotations.length, before);
});

test("annotate list shows tags and text without the tag line, and filters by tag prefix", async () => {
  const k = workflow();
  await knime(k, "annotate", "add", "--text", "Prep", "--colour", "Carrot", "--tag", "my:prep", "--prefix", "my:prep-");
  const all = await knime(k, "annotate", "list", "--json");
  assert.deepEqual(all.json.data.annotations.map((a: { id: string; tag?: string; text: string }) => [a.id, a.tag, a.text]),
    [["root_0", undefined, "Someone's notes"], ["root_1", "my:prep", "Prep"]]);
  assert.equal(all.json.data.annotations[1].colourName, "Carrot");
  const mine = await knime(k, "annotate", "list", "--prefix", "my:", "--json");
  assert.equal(mine.json.data.annotations.length, 1);
  assert.match((await knime(k, "annotate", "list")).stdout, /root_1 +my:prep +Carrot/);
});

test("annotate update changes only what it's given, by tag, and keeps the tag", async () => {
  const k = workflow();
  await knime(k, "annotate", "add", "--text", "Prep", "--tag", "my:prep", "--prefix", "my:prep-");
  const n = k.commands().length;
  assert.equal((await knime(k, "annotate", "update", "my:prep", "--colour", "coral")).code, 0);
  assert.deepEqual(k.commands().slice(n).map((c) => Object.keys(c).sort()), [["annotationId", "borderColor", "kind"]]);
  await knime(k, "annotate", "update", "my:prep", "--text", "Data prep");
  assert.equal(k.annotations[1]!.text?.value, "<p>Data prep</p><p>[[my:prep]]</p>");
  await knime(k, "annotate", "update", "my:prep", "--tag", "my:stage1");
  assert.equal(k.annotations[1]!.text?.value, "<p>Data prep</p><p>[[my:stage1]]</p>");
  const m = k.commands().length;
  const same = await knime(k, "annotate", "update", "my:stage1", "--text", "Data prep", "--colour", "Coral", "--json");
  assert.equal(same.json.data.changed, false);
  assert.equal(k.commands().length, m);
  assert.equal((await knime(k, "annotate", "update", "my:prep", "--text", "x")).code, EXIT.NOT_FOUND);
});

test("annotate update can tag someone's plain-text annotation, converting it to HTML", async () => {
  const k = workflow();
  await knime(k, "annotate", "update", "root_0", "--tag", "my:adopted");
  assert.deepEqual(k.annotations[0]!.text, { value: "<p>Someone's notes</p><p>[[my:adopted]]</p>", contentType: "text/html" });
});

test("annotate move: --by, --around re-fit, --order; unchanged bounds send nothing", async () => {
  const k = workflow();
  await knime(k, "annotate", "add", "--text", "Prep", "--tag", "my:prep", "--around", "my:prep-read");
  const first = structuredClone(k.annotations[1]!.bounds);
  await knime(k, "annotate", "move", "my:prep", "--by", "10,-20");
  assert.deepEqual(k.annotations[1]!.bounds, { ...first, x: first.x + 10, y: first.y - 20 });
  await knime(k, "annotate", "move", "my:prep", "--prefix", "my:prep-");
  assert.ok(k.annotations[1]!.bounds.width > first.width, "grew to take in the second node");
  const n = k.commands().length;
  const again = await knime(k, "annotate", "move", "my:prep", "--prefix", "my:prep-", "--json");
  assert.equal(again.json.data.moved, false);
  assert.equal(k.commands().length, n);
  await knime(k, "annotate", "move", "my:prep", "--order", "back");
  assert.equal(k.annotations[0]!.id, "root_1");
  assert.equal((await knime(k, "annotate", "move", "my:prep", "--order", "sideways")).code, EXIT.USAGE);
});

test("annotate rm refuses untagged annotations without --force and short prefixes always; ids are reused", async () => {
  const k = workflow();
  await knime(k, "annotate", "add", "--tag", "my:a", "--bounds", "0,0,10,10");
  await knime(k, "annotate", "add", "--tag", "my:b", "--bounds", "0,0,10,10");
  assert.equal((await knime(k, "annotate", "rm", "root_0")).code, EXIT.REFUSED);
  assert.equal((await knime(k, "annotate", "rm", "--prefix", "m")).code, EXIT.REFUSED);
  const dry = await knime(k, "annotate", "rm", "--prefix", "my:", "--dry-run", "--json");
  assert.equal(dry.json.data.wouldDelete.length, 2);
  assert.equal(k.annotations.length, 3);
  assert.equal((await knime(k, "annotate", "rm", "my:a")).code, 0);
  const re = await knime(k, "annotate", "add", "--tag", "my:c", "--bounds", "0,0,10,10", "--json");
  assert.equal(re.json.data.id, "root_1", "KNIME reuses the freed id");
  assert.equal((await knime(k, "annotate", "rm", "--prefix", "my:")).code, 0);
  assert.deepEqual(k.annotations.map((a) => a.id), ["root_0"]);
  assert.equal((await knime(k, "annotate", "rm", "0", "--force")).code, 0);
  assert.equal(k.annotations.length, 0);
});
