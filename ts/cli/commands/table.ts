/**
 * `knime node table`: the rows of the table on an executed node's output port, as JSON or CSV. Reads only: a node
 * that hasn't run is an error (NODE_NOT_EXECUTED), never an empty table. Large reads are split into pages, so
 * `--limit all` works for any table the plugin can hold.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { arg, str, type Command } from "../cli.ts";
import { CliError, EXIT, usage } from "../errors.ts";
import type { NodeView, Session } from "../session.ts";

export type Cell = string | number | boolean | null;

export interface TableColumn {
  name: string;
  type: string;
}

export interface TableRow {
  rowId: string;
  cells: Cell[];
}

/** `/api/node/table`'s response. */
export interface TablePage {
  nodeId: string;
  port: number;
  totalRows: number;
  offset: number;
  returned: number;
  columns: TableColumn[];
  rows: TableRow[];
}

/** Rows per request when the CLI pages through a table itself. */
export const PAGE_ROWS = 50_000;
/** Cells per request, well under the plugin's 5,000,000, so wide tables get shorter pages. */
export const PAGE_CELLS = 2_000_000;
/** Rows one request returns when no --limit is given (the plugin's default too). */
export const DEFAULT_LIMIT = 1000;

export interface ReadOptions {
  offset: number;
  /** Rows wanted; Infinity for all of them. */
  limit: number;
  columns?: string[];
}

/**
 * The fields of one CSV line, as RFC 4180 quotes them: `"a,b",c` is two names. Used for --columns, so a column name
 * with a comma in it can still be picked.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === ",") { fields.push(cur); cur = ""; }
    else cur += c;
  }
  if (quoted) throw usage(`Unclosed quote in --columns ${JSON.stringify(line)}`);
  fields.push(cur);
  return fields;
}

/** Column names from every --columns value, in order, without duplicates; undefined for all columns. */
export function parseColumns(values: string[] | undefined): string[] | undefined {
  if (!values?.length) return undefined;
  const names = values.flatMap(parseCsvLine).map((n) => n.trim());
  if (names.some((n) => n === "")) throw usage("--columns has an empty column name", "Separate names with commas: --columns a,b; quote a name that has a comma: --columns '\"a,b\",c'.");
  return [...new Set(names)];
}

/** `--limit`: a whole number of rows (0 gives just the columns and totalRows), or `all`. */
export function parseLimit(text: string | undefined): number {
  if (text === undefined) return DEFAULT_LIMIT;
  if (text.toLowerCase() === "all") return Infinity;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0) throw usage(`--limit must be a whole number of rows or "all", got ${JSON.stringify(text)}`);
  return n;
}

export function parseOffset(text: string | undefined): number {
  if (text === undefined) return 0;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0) throw usage(`--offset must be a whole number of rows (0 is the first row), got ${JSON.stringify(text)}`);
  return n;
}

/** One CSV field, quoted only when it has to be (comma, quote, CR or LF, or leading/trailing space). */
export function csvField(text: string): string {
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A cell as CSV text: missing values empty, numbers as JS prints them (which reads back to the same double). */
export function csvCell(cell: Cell): string {
  if (cell === null) return "";
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return csvField(cell);
}

/** The page as CSV: a header with RowID first, then one line per row; LF line ends. */
export function toCsv(page: Pick<TablePage, "columns" | "rows">): string {
  const lines = [["RowID", ...page.columns.map((c) => c.name)].map(csvField).join(",")];
  for (const r of page.rows) lines.push([csvField(r.rowId), ...r.cells.map(csvCell)].join(","));
  return lines.join("\n") + "\n";
}

/** The page as JSON with one row per line: valid JSON that still greps and diffs line by line. */
export function toJsonLines(page: TablePage): string {
  const { rows, ...head } = page;
  const start = JSON.stringify({ ...head, rows: [] }).slice(0, -3); // up to and including "rows":
  if (!rows.length) return `${start}[]}\n`;
  return `${start}[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}

/**
 * Reads `limit` rows from `offset`, in one request when that's small, else a probe (limit 0, for the column count
 * and totalRows) then pages sized to stay under PAGE_CELLS. Fails with TABLE_CHANGED if the table's size changes
 * between pages (the node was re-executed).
 */
export async function readTable(s: Session, nodeId: string, port: number, o: ReadOptions, context?: string): Promise<TablePage> {
  const request = (offset: number, limit: number) =>
    s.api<TablePage>("/api/node/table", { nodeId, port, offset, limit, ...(o.columns ? { columns: o.columns } : {}) }, context);
  if (o.limit <= DEFAULT_LIMIT) return request(o.offset, o.limit);
  const probe = await request(o.offset, 0);
  const pageRows = Math.max(1, Math.min(PAGE_ROWS, Math.floor(PAGE_CELLS / Math.max(1, probe.columns.length))));
  const end = Math.min(probe.totalRows, o.offset + o.limit);
  const rows: TableRow[] = [];
  for (let at = o.offset; at < end;) {
    const page = await request(at, Math.min(pageRows, end - at));
    if (page.totalRows !== probe.totalRows) {
      throw new CliError({
        code: "TABLE_CHANGED", exit: EXIT.CONFLICT,
        message: `${context ? `${context}: ` : ""}the table went from ${probe.totalRows} to ${page.totalRows} rows while it was read`,
        hint: "The node was reset or re-executed in between. Wait for it to finish (`knime run <node>`), then read again.",
      });
    }
    if (!page.rows.length) break; // can't happen with a stable table; never loop forever
    rows.push(...page.rows);
    at += page.rows.length;
  }
  return { ...probe, returned: rows.length, rows };
}

/** Adds what the plugin's error text can't carry as data: the node's state, or its output ports, or the columns. */
async function withDetails(e: unknown, s: Session, n: NodeView, port: number): Promise<unknown> {
  if (!(e instanceof CliError)) return e;
  let details: unknown;
  if (e.code === "NODE_NOT_EXECUTED" || e.code === "TABLE_INACTIVE") {
    details = { nodeId: n.id, port, state: n.state, message: n.message };
  } else if (e.code === "PORT_OUT_OF_RANGE" || e.code === "NOT_A_TABLE") {
    const ports = await s.api<{ outputs: { index: number; name?: string; type: string }[] }>("/api/node/ports", { nodeId: n.id })
      .catch(() => undefined);
    details = { nodeId: n.id, port, outputs: ports?.outputs.map((p) => ({ index: p.index, name: p.name, type: p.type })) };
  } else if (e.code === "COLUMN_NOT_FOUND") {
    const page = await s.api<TablePage>("/api/node/table", { nodeId: n.id, port, limit: 0 }).catch(() => undefined);
    details = { nodeId: n.id, port, available: page?.columns };
  } else {
    return e;
  }
  return new CliError({ code: e.code, exit: e.exit, message: e.message, cause: e.why, hint: e.hint, status: e.status, details });
}

export const nodeTable: Command = {
  path: ["node", "table"],
  tier: "READ",
  summary: "Rows of the table on an executed node's output port, as JSON or CSV (paged, or --limit all)",
  args: "<node>[:port]",
  options: {
    offset: { type: "string", arg: "<n>", desc: "First row to return, from 0 (default 0)" },
    limit: { type: "string", arg: "<n|all>", desc: `Rows to return (default ${DEFAULT_LIMIT}); all reads the whole table in pages of up to ${PAGE_ROWS}` },
    columns: { type: "string", multiple: true, arg: "<a,b>", desc: "Only these columns, in this order; comma-separated, CSV-quoted if a name has a comma (repeatable)" },
    csv: { type: "boolean", desc: "CSV instead of JSON: header row with RowID first, RFC 4180 quoting, missing values empty" },
    output: { type: "string", short: "o", arg: "<file>", desc: "Write the rows to this file instead of stdout; the path and row count are reported" },
  },
  notes: [
    "Port defaults to 1, the first data port (0 is the flow-variable port): my:predict:1, root:12:2. A metanode has",
    "no flow-variable port, so its ports start at 0, and that's its default.",
    "JSON output is the plugin's page: {nodeId, port, totalRows, offset, returned, columns: [{name, type}], rows:",
    "[{rowId, cells}]}. Numbers are full-precision JSON numbers, missing cells null, NaN and ±Infinity strings.",
    "Without --json the page is printed one row per line; with --json it's the envelope's data.",
    "Never runs anything: an unexecuted node fails with NODE_NOT_EXECUTED (exit 8) and its state; run it first.",
    "An offset at or past the end gives no rows (and the right totalRows). --limit 0 gives just columns and totalRows.",
    "--csv with --json needs -o, since stdout holds the JSON envelope.",
  ],
  examples: [
    "knime node table my:predict",
    "knime node table my:predict:1 --limit 20 --columns 'Churned,P (Churned=1)_gbt1'",
    "knime node table my:scorer --json",
    "knime node table root:12 --limit all --csv -o predictions.csv",
    "knime node table my:partition:2 --offset 1000 --limit 500",
  ],
  async run(ctx) {
    const offset = parseOffset(str(ctx, "offset"));
    const limit = parseLimit(str(ctx, "limit"));
    const columns = parseColumns(ctx.values.columns as string[] | undefined);
    const csv = Boolean(ctx.values.csv);
    const file = str(ctx, "output");
    if (csv && ctx.json && !file) throw usage("--csv with --json needs -o <file>: stdout holds the JSON envelope", "Add -o rows.csv, or drop --json.");
    const s = await ctx.session();
    const snap = await s.snapshot();
    // A metanode has no flow-variable port, so its first data port is 0; everything else's is 1.
    const ref = snap.resolvePort(arg(ctx, 0, "node"), -1);
    const n = ref.node;
    const port = ref.port >= 0 ? ref.port : n.kind === "metanode" ? 0 : 1;
    let page: TablePage;
    try {
      page = await readTable(s, n.id, port, { offset, limit, columns }, `table of ${n.id}:${port}`);
    } catch (e) {
      throw await withDetails(e, s, n, port);
    }
    if (offset > 0 && offset >= page.totalRows) ctx.warn(`offset ${offset} is at or past the end: the table has ${page.totalRows} row(s)`);
    const body = csv ? toCsv(page) : toJsonLines(page);
    const of = `${page.returned} of ${page.totalRows} row(s)${page.offset ? ` from row ${page.offset}` : ""}`;
    if (file) {
      await writeFile(file, body);
      const path = resolve(file);
      ctx.log(`wrote ${of} from ${n.id}:${port} to ${path}`);
      const { rows: _rows, ...head } = page;
      return { data: { ...head, file: path, format: csv ? "csv" : "json" }, text: [] };
    }
    if (!ctx.json) ctx.log(`${of} from ${n.id}${n.label ? ` [${n.label}]` : ""}:${port}`);
    return { data: page, text: [body.slice(0, -1)] };
  },
};
