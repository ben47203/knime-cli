import assert from "node:assert/strict";
import { test } from "node:test";

import { coerce, formatChanges, parseAssignment, planAssignments, planObject, PatchError } from "../patch.ts";
import type { JsonObject } from "../types.ts";

const READER: JsonObject = {
  csvReaderParameters: {
    multiFileSelectionParams: { source: { filterMode: "FILE", path: { path: "/old.csv", file_system_type: "LOCAL" } } },
  },
  name: "x",
};

const plan = (model: JsonObject, ...args: string[]) => planAssignments(model, args.map(parseAssignment));

test("parseAssignment splits path, type and value; the value is verbatim", () => {
  assert.deepEqual(parseAssignment("a.b=1=2"), { keys: ["a", "b"], written: "a.b", type: undefined, raw: "1=2" });
  assert.deepEqual(parseAssignment("a:int=3"), { keys: ["a"], written: "a", type: "int", raw: "3" });
  assert.equal(parseAssignment("a:bool=true").type, "boolean");
  assert.equal(parseAssignment("a:string[]=[]").type, "string[]");
  assert.equal(parseAssignment('["x:y"]:config={}').type, "config");
  assert.throws(() => parseAssignment("a:wat=1"), /Unknown type "wat"/);
  assert.throws(() => parseAssignment("a"), /expected path=value/);
  assert.throws(() => parseAssignment("a:int"), /path:type=value/);
});

test("coerce: JSON first, text otherwise, and strings stay strings", () => {
  assert.equal(coerce("80", undefined, 70), 80);
  assert.equal(coerce("80", undefined, "70"), "80");
  assert.equal(coerce("true", undefined, false), true);
  assert.deepEqual(coerce('["a"]', undefined, []), ["a"]);
  assert.equal(coerce("hello", undefined, 1), "hello");
  assert.equal(coerce("3", "string", 1), "3");
  assert.equal(coerce("NaN", "double", 1), "NaN");
  assert.throws(() => coerce("1.5", "int", 1), /Not an integer/);
  assert.throws(() => coerce("yes", "boolean", 1), /Not a boolean/);
  assert.deepEqual(coerce('["a","b"]', "string[]", undefined), ["a", "b"]);
  assert.throws(() => coerce('{"a":1}', "int[]", undefined), /JSON array/);
  assert.deepEqual(coerce('{"k":1}', "config", undefined), { k: 1 });
});

test("a unique suffix expands to the full path, and says so", () => {
  const p = plan(READER, "source.path.path=/new.csv");
  assert.deepEqual(p.patch, { csvReaderParameters: { multiFileSelectionParams: { source: { path: { path: "/new.csv" } } } } });
  assert.equal(p.changes[0]!.kind, "change");
  assert.equal(p.changes[0]!.before, "/old.csv");
  assert.match(p.warnings[0]!, /source\.path\.path → csvReaderParameters/);
});

test("an ambiguous suffix is an error listing the candidates", () => {
  assert.throws(() => plan(READER, "path=/x"), (e: Error) => e instanceof PatchError && /matches 2 settings/.test(e.message));
});

test("--exact disables suffix matching", () => {
  const p = planAssignments(READER, [parseAssignment("source.path.path=/x")], { exact: true });
  assert.equal(p.changes[0]!.kind, "new");
});

test("unchanged values are reported but left out of the patch", () => {
  const p = plan(READER, "name=x");
  assert.equal(p.changes[0]!.kind, "same");
  assert.deepEqual(p.patch, {});
});

test("an unknown untyped key is sent plain with a warning; a typed one as $type", () => {
  const plain = plan(READER, "custom_prediction_name=pred");
  assert.deepEqual(plain.patch, { custom_prediction_name: "pred" });
  assert.match(plain.warnings[0]!, /isn't in the current settings/);
  const typed = plan(READER, "renamings.n:int=3");
  assert.deepEqual(typed.patch, { renamings: { n: { $type: "int", value: 3 } } });
  const arr = plan(READER, 'cols:string[]=["a"]');
  assert.deepEqual(arr.patch, { cols: { $type: "string[]", value: ["a"] } });
  // json never wraps
  assert.deepEqual(plan(READER, 'raw:json={"a":1}').patch, { raw: { a: 1 } });
});

test("a typed value for an existing key is coerced locally, not wrapped", () => {
  assert.deepEqual(plan({ seed: 1 }, "seed:long=42").patch, { seed: 42 });
});

test("secrets can't be patched", () => {
  assert.throws(() => plan({ password: { $redacted: true } }, "password=x"), /password or credentials/);
});

test("planObject diffs nested and dot-path spec settings per leaf", () => {
  const model: JsonObject = { reference: { useRowID: false, columnName: "a" }, seed: 1 };
  const p = planObject(model, { reference: { columnName: "b", useRowID: false }, seed: 1 });
  assert.deepEqual(p.changes.map((c) => [c.path, c.kind]), [["reference.columnName", "change"], ["reference.useRowID", "same"], ["seed", "same"]]);
  assert.deepEqual(p.patch, { reference: { columnName: "b" } });
});

test("numbers and numeric strings compare equal, since the server coerces", () => {
  assert.equal(planObject({ seed: "42" }, { seed: 42 }).changes[0]!.kind, "same");
});

test("formatChanges marks new, changed and unchanged entries", () => {
  const p = plan({ a: 1, b: 2 }, "a=1", "b=3", "c:int=4");
  assert.deepEqual(formatChanges(p.changes), ["  a = 1 (unchanged)", "~ b: 2 → 3", '+ c = {"$type":"int","value":4}']);
});
