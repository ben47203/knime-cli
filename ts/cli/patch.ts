/**
 * Builds settings patches from `path[:type]=value` assignments (or spec objects) against a node's current settings,
 * and describes what would change.
 */
import { flatten, formatPath, getIn, isObject, leavesOfSpec, parsePathPrefix, unflatten, type Leaf } from "./paths.ts";
import type { Json, JsonObject } from "./types.ts";

/** Type hints accepted after the path. `json` parses the value as JSON and never wraps it. */
/** The server's leaf `$type` names. */
export const LEAF_TYPES = ["string", "int", "long", "short", "byte", "double", "float", "boolean", "char"] as const;
type Leaf_ = (typeof LEAF_TYPES)[number];
/**
 * Accepted after the path: a leaf type, `<leaf>[]` (JSON array value), `config` (JSON object), `config[]`, or `json`,
 * which parses the value as JSON and never wraps it in `$type`.
 */
export type TypeHint = Leaf_ | `${Leaf_}[]` | "config" | "config[]" | "json";
export const TYPE_HINTS: readonly TypeHint[] = [
  ...LEAF_TYPES, ...LEAF_TYPES.map((t) => `${t}[]` as const), "config", "config[]", "json",
];

const HINT_ALIASES: Record<string, TypeHint> = { bool: "boolean", str: "string", integer: "int", number: "double" };

export interface Assignment {
  keys: string[];
  /** As the user wrote it, before suffix expansion. */
  written: string;
  type?: TypeHint;
  raw: string;
}

/** Parses `a.b[“k”].c:int=3`. Everything after the first top-level `=` is the value, verbatim. */
export function parseAssignment(text: string): Assignment {
  const { keys, end } = parsePathPrefix(text);
  let i = end;
  let type: TypeHint | undefined;
  if (text[i] === ":") {
    const eq = text.indexOf("=", i);
    if (eq < 0) throw new Error(`Bad assignment ${JSON.stringify(text)}: expected path:type=value`);
    const name = text.slice(i + 1, eq).trim().toLowerCase();
    const base = name.endsWith("[]") ? name.slice(0, -2) : name;
    const t = `${HINT_ALIASES[base] ?? base}${name.endsWith("[]") ? "[]" : ""}` as TypeHint;
    if (!TYPE_HINTS.includes(t)) {
      throw new Error(`Unknown type "${name}" in ${JSON.stringify(text)}; use one of ${LEAF_TYPES.join(", ")}, <type>[], config, config[] or json`);
    }
    type = t;
    i = eq;
  }
  if (text[i] !== "=") throw new Error(`Bad assignment ${JSON.stringify(text)}: expected path=value`);
  return { keys, written: text.slice(0, end), type, raw: text.slice(i + 1) };
}

/**
 * The value an assignment stands for. Without a type: JSON if it parses, else the text as a string; and if the
 * existing entry is a string, the text stays a string (so `name=80` keeps `"80"`).
 */
export function coerce(raw: string, type: TypeHint | undefined, existing: Json | undefined): Json {
  if (type?.endsWith("[]") || type === "config") {
    let v: Json;
    try {
      v = JSON.parse(raw) as Json;
    } catch {
      throw new Error(`${type} needs a JSON ${type === "config" ? "object" : "array"}: ${JSON.stringify(raw)}`);
    }
    if (type === "config" ? !isObject(v) : !Array.isArray(v)) throw new Error(`${type} needs a JSON ${type === "config" ? "object" : "array"}: ${JSON.stringify(raw)}`);
    return v;
  }
  switch (type) {
    case "string":
    case "char":
      return raw;
    case "json":
      return JSON.parse(raw) as Json;
    case "boolean":
      if (raw === "true" || raw === "false") return raw === "true";
      throw new Error(`Not a boolean: ${JSON.stringify(raw)}`);
    case "int":
    case "long":
    case "short":
    case "byte": {
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`Not an integer: ${JSON.stringify(raw)}`);
      return n;
    }
    case "double":
    case "float": {
      if (["NaN", "Infinity", "-Infinity"].includes(raw)) return raw; // how the API spells non-finite values
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`Not a number: ${JSON.stringify(raw)}`);
      return n;
    }
    case undefined: {
      if (typeof existing === "string") return raw;
      try {
        return JSON.parse(raw) as Json;
      } catch {
        return raw;
      }
    }
    default:
      return JSON.parse(raw) as Json; // config[] is handled above; kept total for the type checker
  }
}

export type ChangeKind = "change" | "same" | "new";

export interface Change {
  path: string;
  keys: string[];
  kind: ChangeKind;
  before?: Json;
  after: Json;
  /** Set when the written path was a suffix and got expanded. */
  expandedFrom?: string;
}

export interface PatchPlan {
  patch: JsonObject;
  changes: Change[];
  warnings: string[];
}

export interface PlanOptions {
  /** Disable suffix matching. */
  exact?: boolean;
}

interface Item {
  keys: string[];
  written: string;
  value: (existing: Json | undefined) => Json;
  type?: TypeHint;
}

/** Plans a patch from command-line assignments. */
export function planAssignments(model: JsonObject, assignments: readonly Assignment[], opts: PlanOptions = {}): PatchPlan {
  return plan(
    model,
    assignments.map((a) => ({ keys: a.keys, written: a.written, type: a.type, value: (ex) => coerce(a.raw, a.type, ex) })),
    opts,
  );
}

/** Plans a patch from a settings object (nested, dot-path keys, or a mix), e.g. from `--patch` or an apply spec. */
export function planObject(model: JsonObject, settings: JsonObject, opts: PlanOptions = {}): PatchPlan {
  return plan(model, leavesOfSpec(settings).map((l: Leaf) => ({ keys: l.keys, written: l.path, value: () => l.value })), opts);
}

function plan(model: JsonObject, items: readonly Item[], opts: PlanOptions): PatchPlan {
  const leaves = flatten(model);
  const warnings: string[] = [];
  const changes: Change[] = [];
  for (const item of items) {
    let keys = item.keys;
    let expandedFrom: string | undefined;
    let existing = getIn(model, keys);
    if (existing === undefined && !opts.exact) {
      const match = resolveSuffix(leaves, model, keys);
      if (match.length === 1) {
        keys = match[0]!;
        expandedFrom = item.written;
        existing = getIn(model, keys);
        warnings.push(`${item.written} → ${formatPath(keys)}`);
      } else if (match.length > 1) {
        throw new PatchError(
          `${item.written} matches ${match.length} settings: ${match.map(formatPath).slice(0, 8).join(", ")}; write more of the path`,
        );
      }
    }
    let after = item.value(existing);
    const path = formatPath(keys);
    if (existing === undefined) {
      if (item.type && item.type !== "json") {
        after = { $type: item.type, value: after };
        warnings.push(`${path} isn't in the current settings; sending it as a typed value to create it (needs a server that supports $type)`);
      } else {
        warnings.push(`${path} isn't in the current settings; sending it anyway, since older servers hide keys whose value is null. `
          + `The server rejects it if the node doesn't know it; to create a key, give a type (${path}:string=…)`);
      }
      changes.push({ path, keys, kind: "new", after, expandedFrom });
      continue;
    }
    if (isObject(existing) && "$redacted" in existing) {
      throw new PatchError(`${path} holds a password or credentials and can't be set through this API`);
    }
    if (isObject(after) && isObject(existing) && !("$type" in after)) {
      // A group patch: expand into its leaves so the diff is per setting.
      for (const l of flatten(after)) {
        const sub = [...keys, ...l.keys];
        const before = getIn(model, sub);
        changes.push({ path: formatPath(sub), keys: sub, kind: before === undefined ? "new" : same(before, l.value) ? "same" : "change", before, after: l.value, expandedFrom });
      }
      continue;
    }
    changes.push({ path, keys, kind: same(existing, after) ? "same" : "change", before: existing, after, expandedFrom });
  }
  // Unchanged entries are left out; an empty patch means there's nothing to send.
  const patch = unflatten(changes.filter((c) => c.kind !== "same").map((c) => ({ keys: c.keys, value: c.after })));
  return { patch, changes, warnings };
}

/** Paths in `model` ending with `keys`, either a leaf or a group. */
function resolveSuffix(leaves: readonly Leaf[], model: JsonObject, keys: readonly string[]): string[][] {
  const seen = new Map<string, string[]>();
  for (const l of leaves) {
    // Every prefix of a leaf path is a candidate too (a group), so check each end position.
    for (let end = keys.length; end <= l.keys.length; end++) {
      const tail = l.keys.slice(end - keys.length, end);
      if (tail.every((k, i) => k === keys[i])) {
        const cand = l.keys.slice(0, end);
        if (getIn(model, cand) !== undefined) seen.set(formatPath(cand), cand);
      }
    }
  }
  return [...seen.values()];
}

function same(a: Json | undefined, b: Json): boolean {
  if (typeof a === "number" && typeof b === "string") return String(a) === b; // the server coerces
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return JSON.stringify(a) === JSON.stringify(b);
}

export class PatchError extends Error {}

/** Human-readable diff lines. */
export function formatChanges(changes: readonly Change[]): string[] {
  return changes.map((c) => {
    const after = JSON.stringify(c.after);
    if (c.kind === "new") return `+ ${c.path} = ${after}`;
    if (c.kind === "same") return `  ${c.path} = ${after} (unchanged)`;
    return `~ ${c.path}: ${JSON.stringify(c.before)} → ${after}`;
  });
}
