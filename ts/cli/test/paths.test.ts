import assert from "node:assert/strict";
import { test } from "node:test";

import { flatten, formatPath, leavesOfSpec, parsePath, parsePathPrefix, unflatten } from "../paths.ts";
import type { JsonObject } from "../types.ts";

const MISSING: JsonObject = {
  columnSettings: {},
  dataTypeSettings: {
    "org.knime.core.data.def.DoubleCell": { factoryID: "Median", settings: {} },
  },
  "column filter": { included_names: ["a", "b"], "filter-type": "STANDARD" },
  seed: 42,
  empty: null,
};

test("flatten writes dotted, spaced and empty keys so they parse back", () => {
  const paths = flatten(MISSING).map((l) => l.path);
  assert.deepEqual(paths, [
    "columnSettings",
    'dataTypeSettings["org.knime.core.data.def.DoubleCell"].factoryID',
    'dataTypeSettings["org.knime.core.data.def.DoubleCell"].settings',
    "column filter.included_names",
    "column filter.filter-type",
    "seed",
    "empty",
  ]);
  for (const l of flatten(MISSING)) assert.deepEqual(parsePath(l.path), l.keys);
});

test("arrays, nulls and empty groups are leaves", () => {
  const leaves = flatten(MISSING);
  assert.deepEqual(leaves.find((l) => l.path === "column filter.included_names")?.value, ["a", "b"]);
  assert.deepEqual(leaves.find((l) => l.path === "columnSettings")?.value, {});
  assert.equal(leaves.find((l) => l.path === "empty")?.value, null);
});

test("unflatten is the inverse of flatten", () => {
  assert.deepEqual(unflatten(flatten(MISSING)), MISSING);
});

test("redacted placeholders and typed values stay whole", () => {
  const leaves = flatten({ auth: { password: { $redacted: true } }, n: { $type: "int", value: 3 } });
  assert.deepEqual(leaves.map((l) => l.path), ["auth.password", "n"]);
});

test("bracket keys honour JSON escapes, and paths stop at = or :", () => {
  assert.deepEqual(parsePath('a["x\\"y.z"].b'), ["a", 'x"y.z', "b"]);
  assert.deepEqual(parsePath('["a=b"]["c:d"]'), ["a=b", "c:d"]);
  assert.deepEqual(parsePathPrefix("a.b:int=3"), { keys: ["a", "b"], end: 3 });
  assert.deepEqual(parsePathPrefix("a.b=x.y"), { keys: ["a", "b"], end: 3 });
  assert.equal(formatPath(["", "a.b", "c"]), '[""]["a.b"].c');
});

test("bad paths are rejected with the position", () => {
  assert.throws(() => parsePath("a..b"), /empty segment/);
  assert.throws(() => parsePath('a["b]'), /unterminated/);
  assert.throws(() => parsePath("=3"), /no key/);
  assert.throws(() => parsePath("a[b]"), /expected \["key"\]/);
});

test("spec settings mix dot-path keys and nested objects", () => {
  const leaves = leavesOfSpec({ "source.path.path": "/x", reference: { columnName: "y" }, "column filter": { a: 1 } });
  assert.deepEqual(leaves.map((l) => l.keys), [["source", "path", "path"], ["reference", "columnName"], ["column filter", "a"]]);
});
