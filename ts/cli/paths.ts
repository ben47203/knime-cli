/**
 * Dot-paths for node settings: `a.b.c`, with keys that can't stand bare written as `["…"]` (JSON string syntax), e.g.
 * `dataTypeSettings["org.knime.core.data.def.DoubleCell"].factoryID`.
 *
 * Arrays are leaves: the server replaces KNIME arrays whole, so a path never indexes into one.
 */
import type { Json, JsonObject } from "./types.ts";

/** Characters that force a key into bracket form. `:` and `=` would otherwise end the path in an assignment. */
const SPECIAL = /[.[\]"=:]|^\s|\s$|^$/;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One path segment as written in a dot-path. */
export function formatKey(key: string): string {
  return SPECIAL.test(key) ? `[${JSON.stringify(key)}]` : key;
}

export function formatPath(keys: readonly string[]): string {
  let out = "";
  for (const k of keys) {
    const f = formatKey(k);
    out += f.startsWith("[") || out === "" ? f : `.${f}`;
  }
  return out;
}

/**
 * Parses a dot-path from the start of `text`, stopping at a top-level `=` or `:` (or the end). Returns the keys and
 * the index where parsing stopped.
 */
export function parsePathPrefix(text: string): { keys: string[]; end: number } {
  const keys: string[] = [];
  let i = 0;
  let current = "";
  let bare = false; // inside a bare segment
  const flush = () => {
    if (bare) keys.push(current);
    current = "";
    bare = false;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "[") {
      if (bare) flush();
      if (text[i + 1] !== '"') throw new Error(`Bad path ${JSON.stringify(text)}: expected ["key"] at ${i}`);
      // Find the closing quote, honouring escapes, then parse it as a JSON string.
      let j = i + 2;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (text[j + 1] !== "]") throw new Error(`Bad path ${JSON.stringify(text)}: unterminated ["key"] at ${i}`);
      keys.push(JSON.parse(text.slice(i + 1, j + 1)) as string);
      i = j + 2;
      if (text[i] === ".") i++;
      continue;
    }
    if (c === "." ) {
      if (!bare) throw new Error(`Bad path ${JSON.stringify(text)}: empty segment at ${i}`);
      flush();
      i++;
      continue;
    }
    if (c === "=" || c === ":") break;
    current += c;
    bare = true;
    i++;
  }
  flush();
  if (keys.length === 0) throw new Error(`Bad path ${JSON.stringify(text)}: no key before "${text[i] ?? ""}"`);
  return { keys, end: i };
}

export function parsePath(text: string): string[] {
  const { keys, end } = parsePathPrefix(text);
  if (end !== text.length) throw new Error(`Bad path ${JSON.stringify(text)}: unexpected "${text[end]}" at ${end}`);
  return keys;
}

export interface Leaf {
  keys: string[];
  path: string;
  value: Json;
}

/**
 * Every leaf of a settings object, depth first in key order. Arrays, primitives, null and empty objects are leaves.
 * A `{"$redacted": true}` placeholder or a `{"$type": …}` typed value is a leaf too.
 */
export function flatten(obj: JsonObject, prefix: string[] = []): Leaf[] {
  const out: Leaf[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const keys = [...prefix, k];
    if (isObject(v) && Object.keys(v).length > 0 && !("$redacted" in v) && !("$type" in v)) {
      out.push(...flatten(v, keys));
    } else {
      out.push({ keys, path: formatPath(keys), value: v });
    }
  }
  return out;
}

/** Sets `value` at `keys` in `target`, creating groups on the way. Throws if a leaf is in the way. */
export function setIn(target: JsonObject, keys: readonly string[], value: Json): void {
  let cur = target;
  for (const [i, k] of keys.entries()) {
    if (i === keys.length - 1) {
      cur[k] = value;
      return;
    }
    const next = cur[k];
    if (next === undefined) {
      const created: JsonObject = {};
      cur[k] = created;
      cur = created;
    } else if (isObject(next)) {
      cur = next;
    } else {
      throw new Error(`Conflicting paths: ${formatPath(keys.slice(0, i + 1))} is both a value and a group`);
    }
  }
}

export function getIn(obj: JsonObject, keys: readonly string[]): Json | undefined {
  let cur: Json | undefined = obj;
  for (const k of keys) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Builds a nested object from leaves; the inverse of {@link flatten}. */
export function unflatten(leaves: readonly { keys: readonly string[]; value: Json }[]): JsonObject {
  const out: JsonObject = {};
  for (const l of leaves) setIn(out, l.keys, l.value);
  return out;
}

/**
 * Normalises a settings object whose top-level keys may themselves be dot-paths (as in an apply spec), e.g.
 * `{"source.path.path": "/x", "seed": 1}`, into leaves. Keys are parsed as dot-paths only when they parse cleanly;
 * nested objects below are taken literally.
 */
export function leavesOfSpec(settings: JsonObject): Leaf[] {
  const out: Leaf[] = [];
  for (const [k, v] of Object.entries(settings)) {
    let keys: string[];
    try {
      keys = parsePath(k);
    } catch {
      keys = [k];
    }
    if (isObject(v) && !("$type" in v)) {
      for (const l of flatten(v, keys)) out.push(l);
    } else {
      out.push({ keys, path: formatPath(keys), value: v });
    }
  }
  return out;
}
