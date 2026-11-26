import assert from "node:assert/strict";
import { test } from "node:test";

import { htmlToText, joinLabel, plainText, splitLabel, textToHtml } from "../text.ts";

test("htmlToText turns paragraphs and breaks into lines and decodes entities", () => {
  assert.equal(htmlToText("<p>Stage <b>1</b></p><p>a &amp; b&nbsp;&lt;c&gt; &#39;d&#x27;</p>"), "Stage 1\na & b <c> 'd'");
  assert.equal(htmlToText("<p>one<br>two</p><p></p>"), "one\ntwo");
});

test("textToHtml round-trips through htmlToText, escaping markup", () => {
  const t = "Prep <raw> & clean\n\nthen split";
  assert.equal(textToHtml(t), "<p>Prep &lt;raw&gt; &amp; clean</p><p></p><p>then split</p>");
  assert.equal(htmlToText(textToHtml(t)), t);
});

test("a node annotation's first line is the label, the rest its note", () => {
  assert.deepEqual(splitLabel("hs:reader"), { label: "hs:reader", note: undefined });
  assert.deepEqual(splitLabel("hs:reader\nReads the extract\nmonthly"), { label: "hs:reader", note: "Reads the extract\nmonthly" });
  assert.deepEqual(splitLabel("\nonly a note"), { label: undefined, note: "only a note" });
  assert.deepEqual(splitLabel(plainText({ value: "<p>hs:x</p><p>note</p>", contentType: "text/html" })), { label: "hs:x", note: "note" });
  for (const [l, n] of [["a", "b\nc"], [undefined, "n"], ["a", undefined]] as const) {
    assert.deepEqual(splitLabel(joinLabel(l, n)), { label: l, note: n });
  }
});
