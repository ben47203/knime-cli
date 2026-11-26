/**
 * Column selectors in apply specs: `{"$columns": {"from": "missing:1", "type": "number", "exclude": ["y"]}}` stands
 * for a string array of column names, read from an upstream node's output spec when apply reaches the node.
 */
import { isObject } from "./paths.ts";
import type { ColumnSpec, Json, JsonObject } from "./types.ts";

export interface ColumnSelector {
  /** `key[:port]` of a spec node's output (port 1 by default); default: whatever feeds this node's input 1. */
  from?: string;
  /** Column type(s) to keep: number, integer, decimal, string, boolean, datetime, or text in KNIME's type name. */
  type?: string | string[];
  /** Only these columns (in this order), if present. */
  include?: string[];
  /** Drop these. */
  exclude?: string[];
  /** Keep names matching this regular expression. */
  pattern?: string;
}

const KEYS = new Set(["from", "type", "include", "exclude", "pattern"]);

/** Named type groups, matched against KNIME's display names (`Number (Integer)`, `String`, `Local Date`, …). */
export const TYPE_GROUPS: Record<string, RegExp> = {
  number: /^Number\b|\b(integer|long|double|float)\b/i,
  integer: /^Number \((Integer|Long)\)|^(Integer|Long)\b/i,
  decimal: /^Number \((Float|Double)\)|^(Double|Float)\b/i,
  string: /^String\b/i,
  boolean: /^Boolean\b/i,
  datetime: /\b(date|time|zoned|duration|period)\b/i,
};

export function isSelector(v: Json | undefined): v is { $columns: JsonObject } {
  return isObject(v as Json) && "$columns" in (v as JsonObject);
}

/** Every selector in a settings object, in document order. */
export function findSelectors(v: Json | undefined, out: ColumnSelector[] = []): ColumnSelector[] {
  if (isSelector(v)) out.push(v.$columns as ColumnSelector);
  else if (Array.isArray(v)) v.forEach((x) => findSelectors(x, out));
  else if (isObject(v as Json)) Object.values(v as JsonObject).forEach((x) => findSelectors(x, out));
  return out;
}

/** Problems with one selector's shape, for resolveSpec. */
export function selectorProblems(sel: unknown): string[] {
  if (!isObject(sel as Json)) return ['"$columns" must be an object, e.g. {"from": "reader:1", "type": "number"}'];
  const s = sel as JsonObject;
  const problems: string[] = [];
  const outer = Object.keys(s).filter((k) => !KEYS.has(k));
  if (outer.length) problems.push(`unknown "$columns" field(s) ${outer.join(", ")}; known: ${[...KEYS].join(", ")}`);
  if (s.from !== undefined && typeof s.from !== "string") problems.push('"$columns".from must be "key" or "key:port"');
  for (const k of ["include", "exclude"]) {
    if (s[k] !== undefined && !(Array.isArray(s[k]) && (s[k] as Json[]).every((x) => typeof x === "string"))) problems.push(`"$columns".${k} must be an array of column names`);
  }
  const types = s.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type];
  for (const t of types) if (typeof t !== "string" || !t) problems.push('"$columns".type must be a type name or an array of them');
  if (s.pattern !== undefined) {
    try {
      new RegExp(String(s.pattern));
    } catch (e) {
      problems.push(`"$columns".pattern: ${(e as Error).message}`);
    }
  }
  return problems;
}

function typeMatches(type: string, wanted: string): boolean {
  const group = TYPE_GROUPS[wanted.toLowerCase()];
  return group ? group.test(type) : type.toLowerCase().includes(wanted.toLowerCase());
}

/** The names a selector picks from `columns`, and warnings for names it mentions that aren't there. */
export function selectColumns(sel: ColumnSelector, columns: readonly ColumnSpec[]): { names: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const have = new Set(columns.map((c) => c.name));
  const missing = (field: string, names: string[] | undefined) => {
    const gone = (names ?? []).filter((n) => !have.has(n));
    if (gone.length) warnings.push(`$columns ${field} names ${gone.map((n) => JSON.stringify(n)).join(", ")}, not in the input (${[...have].join(", ") || "no columns"})`);
  };
  missing("include", sel.include);
  missing("exclude", sel.exclude);
  let picked = sel.include ? sel.include.map((n) => columns.find((c) => c.name === n)).filter((c): c is ColumnSpec => Boolean(c)) : [...columns];
  const types = sel.type === undefined ? [] : Array.isArray(sel.type) ? sel.type : [sel.type];
  if (types.length) picked = picked.filter((c) => types.some((t) => typeMatches(c.type, t)));
  if (sel.pattern !== undefined) {
    const re = new RegExp(sel.pattern);
    picked = picked.filter((c) => re.test(c.name));
  }
  const drop = new Set(sel.exclude ?? []);
  const names = picked.map((c) => c.name).filter((n) => !drop.has(n));
  if (!names.length) warnings.push(`$columns ${JSON.stringify(sel)} picks no columns from ${[...have].join(", ") || "an empty table"}`);
  return { names, warnings };
}

/** A copy of `v` with every selector replaced by what `pick` returns for it. */
export function substitute(v: Json, pick: (sel: ColumnSelector) => string[]): Json {
  if (isSelector(v)) return pick(v.$columns as ColumnSelector);
  if (Array.isArray(v)) return v.map((x) => substitute(x, pick));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, pick)]));
  return v;
}
