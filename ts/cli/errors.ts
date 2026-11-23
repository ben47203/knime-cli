/**
 * Error translation: every failure leaves the CLI as a {@link CliError} with a stable code and exit status, the
 * likely cause, and a next step. Known server messages are matched by status and text; see TRANSLATIONS.
 */
import { HttpError, RpcError } from "../src/client.ts";

export const EXIT = {
  OK: 0,
  ERROR: 1, // unexpected; a bug or an unknown server error
  USAGE: 2, // bad arguments or spec
  NOT_FOUND: 3, // instance, project, node, label or alias
  UNAVAILABLE: 4, // no KNIME, not ready yet, connection refused
  GATEWAY: 5, // 504 / 503-stalled: KNIME stopped confirming commands
  CONFLICT: 6, // 409: something is executing
  REJECTED: 7, // 400: the server refused the request (settings, connection, id)
  INCOMPLETE: 8, // run finished with nodes not executed, or timed out
  REFUSED: 9, // the CLI's own safety rules (e.g. unscoped delete without --force)
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface CliErrorInit {
  code: string;
  exit: ExitCode;
  message: string;
  cause?: string;
  hint?: string;
  status?: number;
  details?: unknown;
}

export class CliError extends Error {
  readonly code: string;
  readonly exit: ExitCode;
  readonly why?: string;
  readonly hint?: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(init: CliErrorInit) {
    super(init.message);
    this.code = init.code;
    this.exit = init.exit;
    this.why = init.cause;
    this.hint = init.hint;
    this.status = init.status;
    this.details = init.details;
  }

  toJSON() {
    return { code: this.code, message: this.message, cause: this.why, hint: this.hint, status: this.status, details: this.details };
  }
}

export const usage = (message: string, hint?: string) => new CliError({ code: "USAGE", exit: EXIT.USAGE, message, hint });

export interface Translation {
  code: string;
  exit: ExitCode;
  /** HTTP status to match, or "rpc" for a JSON-RPC error, or "net" for a connection failure. */
  status?: number | "rpc" | "net";
  /** Text the message must contain (case-insensitive); omitted matches any message with that status. */
  match?: RegExp;
  cause: string;
  hint: string;
}

export const SAVE_BLOCKED_CAUSE = "The project can't be saved in place: it's a component project, a temporary copy of a Hub, "
  + "Server or archive workflow, read-only, or its folder is locked.";
export const SAVE_BLOCKED_HINT = "Save it from KNIME instead (Save As, or upload it). `knime workflow show` says why (saveBlocked).";

/** Ordered: the first match wins, so specific entries come before catch-alls for the same status. */
export const TRANSLATIONS: readonly Translation[] = [
  {
    code: "GATEWAY_TIMEOUT", exit: EXIT.GATEWAY, status: 504,
    cause: "KNIME didn't confirm the workflow command within 30 s. The command was probably applied anyway.",
    hint: "Run `knime workflow show` to see what happened before retrying. `knime apply` is safe to re-run.",
  },
  {
    code: "GATEWAY_STALLED", exit: EXIT.GATEWAY, status: 503, match: /unanswered|earlier calls/i,
    cause: "KNIME has stopped confirming workflow commands; more calls would only pile up.",
    hint: "Stop issuing commands. Ask the user to close and reopen the workflow, or restart KNIME.",
  },
  {
    code: "NOT_READY", exit: EXIT.UNAVAILABLE, status: 503,
    cause: "KNIME's UI hasn't finished initialising, so the API isn't available yet.",
    hint: "Wait a few seconds and retry, or run `knime status --wait 60`.",
  },
  // node table: before the catch-alls for 400 and 409. The plugin's messages carry no fields, so they're matched by text.
  {
    code: "PORT_OUT_OF_RANGE", exit: EXIT.REJECTED, status: 400, match: /no output port \d+ on /i,
    cause: "The node has no output port with that number. Port 0 is the flow-variable port, so data ports start at 1.",
    hint: "The message lists the node's output ports (also in `details` with --json); address one as <node>:<port>.",
  },
  {
    code: "NOT_A_TABLE", exit: EXIT.REJECTED, status: 400, match: /not a table port/i,
    cause: "That output port holds a model, image or flow variables, not a table. Port 0 is always the flow-variable port.",
    hint: "Pick a table port from the list in the message; learners often have their table on port 1 and the model on a higher port.",
  },
  {
    code: "COLUMN_NOT_FOUND", exit: EXIT.NOT_FOUND, status: 400, match: /unknown column/i,
    cause: "--columns names a column that isn't in the table. Names are exact and case-sensitive.",
    hint: "The message lists the available columns; `knime node table <node> --limit 0` prints just the columns.",
  },
  {
    code: "TABLE_INACTIVE", exit: EXIT.INCOMPLETE, status: 409, match: /inactive branch, so it holds no table/i,
    cause: "The port is on an inactive branch (an IF Switch or similar switched it off), so it has no table.",
    hint: "Read the active branch instead, or change the switch upstream and run again.",
  },
  {
    code: "NODE_NOT_EXECUTED", exit: EXIT.INCOMPLETE, status: 409, match: /holds no table until/i,
    cause: "A port has a table only once its node has executed; reading never runs anything. The message says the node's state.",
    hint: "Run it first (`knime run <node>`), then read the table again.",
  },
  {
    code: "TABLE_CHANGED", exit: EXIT.CONFLICT, status: 409, match: /changed while it was read/i,
    cause: "The node was reset or re-executed while its table was being read, so the rows would have been inconsistent.",
    hint: "Wait for the node to finish (`knime run <node>` waits), then read again.",
  },
  {
    code: "INVALID_NODE_ID", exit: EXIT.REJECTED, status: 400, match: /invalid (nodeId|workflowId|nodeIds)/i,
    cause: "Node ids look like root:7 (or root:5:0:3 inside a metanode or component).",
    hint: "Use an id from `knime workflow show`, a bare number (7), or the node's label.",
  },
  {
    code: "METANODE_HAS_NO_SETTINGS", exit: EXIT.REJECTED, status: 400, match: /metanode/i,
    cause: "A metanode has no settings of its own.",
    hint: "Pass it as `--workflow <id>` to reach the nodes inside it.",
  },
  {
    code: "UNKNOWN_SETTING", exit: EXIT.REJECTED, status: 400, match: /unknown setting/i,
    cause: "The patch gives a plain value for a key the node doesn't have; plain values only change existing keys. A node shows no keys until it's connected and its input has a table spec.",
    hint: "Run `knime node settings <node>` to list the keys. To create a key (a list entry, a missing tree-learner key), give a typed value: `path:string=…` or {\"$type\": …, \"value\": …}; for tree learners, GroupBy and Column Renamer use a preset (`knime nodes info <alias>`). If the model is empty, connect the node and run upstream first.",
  },
  {
    code: "SETTING_PROTECTED", exit: EXIT.REJECTED, status: 400, match: /password or credentials|redacted placeholder|internal settings-model/i,
    cause: "Secrets and settings-model internals can't be read or written through this API.",
    hint: "Leave that key out of the patch; set secrets in the node's dialog in KNIME.",
  },
  {
    code: "NOT_AN_IMAGE_PORT", exit: EXIT.REJECTED, status: 400, match: /not an image port|has no output port/i,
    cause: "Images come only from Image output ports; port 0 is the flow-variable port.",
    hint: "Leave out --port to use the first image port, or list the ports with `knime node ports <node>`.",
  },
  {
    code: "SETTINGS_REJECTED", exit: EXIT.REJECTED, status: 400, match: /rejected these settings|not found|must be|expected/i,
    cause: "The node refused the patched settings (wrong type or shape, or a value it doesn't accept). Nothing changed.",
    hint: "Compare with `knime node settings <node> --json`. Recipes with verified keys: `knime guide recipes`.",
  },
  {
    code: "IMAGE_NOT_READY", exit: EXIT.INCOMPLETE, status: 409, match: /holds no image/i,
    cause: "An image port is empty until its node executes, and stays empty on an inactive branch.",
    hint: "Run the node (`knime run <node>`), or use `knime node image <node> --enable`, which runs it.",
  },
  {
    code: "SAVE_BLOCKED", exit: EXIT.REJECTED, status: 409, match: /can't save|saving .* was cancelled/i,
    cause: SAVE_BLOCKED_CAUSE, hint: SAVE_BLOCKED_HINT,
  },
  {
    code: "BUSY", exit: EXIT.CONFLICT, status: 409,
    cause: "The node, or something downstream of it, is queued or executing, so it can't be changed or reset.",
    hint: "Wait for it (`knime run <node>` waits) or cancel it in KNIME, then retry.",
  },
  {
    code: "NOT_FOUND", exit: EXIT.NOT_FOUND, status: 404,
    cause: "No such project, workflow or node is open in KNIME. Ids are reused after deletes, so a cached id may be stale.",
    hint: "Run `knime workflow show` for the open projects and current node ids, and address your nodes by label.",
  },
  {
    code: "NOT_SUPPORTED", exit: EXIT.UNAVAILABLE, status: 501,
    cause: "The plugin can't reach a KNIME internal this request needs in this KNIME version.",
    hint: "`knime status --json` lists the plugin's capabilities and why any is missing. Other commands still work.",
  },
  {
    code: "UNAUTHORISED", exit: EXIT.UNAVAILABLE, status: 401,
    cause: "The token didn't match; the discovery file is probably from an earlier KNIME run.",
    hint: "Restart the CLI command; if it persists, pick the instance explicitly with `--pid` (see `knime status`).",
  },
  {
    code: "FORBIDDEN", exit: EXIT.UNAVAILABLE, status: 403,
    cause: "The server refused the request's Host or Origin; browsers are blocked on purpose.",
    hint: "Call the API from a terminal or script, not a browser.",
  },
  {
    code: "CONNECTION_FAILED", exit: EXIT.REJECTED, status: "rpc", match: /connection could not be created/i,
    cause: "KNIME refused the connection: usually a wrong port index (port 0 is the flow-variable port, data ports start at 1), incompatible port types, or a cycle.",
    hint: "Check both nodes' ports with `knime node ports <node>`. Learners often have the model on a higher port (random forest: 3).",
  },
  {
    code: "RPC_NOT_ALLOWED", exit: EXIT.REJECTED, status: "rpc", match: /JSON-RPC -32001\b|not available via knime-cli/i,
    cause: "Only WorkflowService.executeWorkflowCommand and undo/redo are allowed through /rpc.",
    hint: "Use the /api endpoints (the CLI's commands) for reads.",
  },
  {
    code: "RPC_ERROR", exit: EXIT.REJECTED, status: "rpc",
    cause: "KNIME rejected the workflow command.",
    hint: "Re-read the workflow with `knime workflow show`; node ids may have changed.",
  },
  {
    code: "NO_CONNECTION", exit: EXIT.UNAVAILABLE, status: "net",
    cause: "Nothing answered at the instance's URL; KNIME may have exited without removing its discovery file.",
    hint: "Start KNIME (with the knime-cli plugin) and run `knime status`.",
  },
  {
    code: "BAD_REQUEST", exit: EXIT.REJECTED, status: 400,
    cause: "The server rejected the request.",
    hint: "Check the arguments; `knime <command> --help` shows the expected form.",
  },
];

/** Errors the CLI raises itself, listed for `knime guide errors`. */
export const CLI_ERRORS: readonly Pick<Translation, "code" | "exit" | "cause" | "hint">[] = [
  {
    code: "EMPTY_MODEL", exit: EXIT.REJECTED,
    cause: "The node shows no settings (`model: {}`): it isn't connected yet (learners and predictors), or its input has no table spec yet.",
    hint: "Run the nodes upstream of it first (`knime run <upstream>`), then set its settings. `knime apply` does this for you.",
  },
  {
    code: "NOT_EXECUTED", exit: EXIT.INCOMPLETE,
    cause: "Execution finished but some nodes didn't run, often because they were never configured (IDLE). The server can report success in this case.",
    hint: "Read each node's message in the output, fix its settings or inputs, and run again.",
  },
  {
    code: "TIMEOUT", exit: EXIT.INCOMPLETE,
    cause: "Nodes were still executing when --timeout ran out. They keep running in KNIME.",
    hint: "Run the same `knime run` again to keep waiting, with a larger --timeout.",
  },
  {
    code: "REFUSED", exit: EXIT.REFUSED,
    cause: "A destructive command would touch nodes that aren't scoped by a label.",
    hint: "Label your nodes and delete by label or `--prefix`, or pass --force if you really mean it.",
  },
  {
    code: "AMBIGUOUS", exit: EXIT.USAGE,
    cause: "A label or suffix matches more than one node or setting.",
    hint: "Use the node id, or write more of the settings path.",
  },
  {
    code: "CAPABILITY_MISSING", exit: EXIT.UNAVAILABLE,
    cause: "`/status` says the plugin couldn't find a KNIME internal this command needs (e.g. workflowSvg for the canvas).",
    hint: "`knime status --json` shows capabilityProblems. Other commands still work.",
  },
  {
    code: "NO_BROWSER", exit: EXIT.UNAVAILABLE,
    cause: "A PNG of the canvas needs a headless browser (its text is HTML inside the SVG), and none was found.",
    hint: "Install Chrome or Chromium, run `npx playwright install chromium`, or set KNIME_CLI_BROWSER; or keep the SVG.",
  },
  {
    code: "NO_COLUMNS", exit: EXIT.REJECTED,
    cause: "An apply spec's $columns selector reads an output port that has no table spec (not a table, or not configured).",
    hint: "Check the port with `knime node ports <node>`; `from` is key:port of a spec node's output, 1 being the first data port.",
  },
  {
    code: "NO_IMAGE_PORT", exit: EXIT.NOT_FOUND,
    cause: "The node has no Image output port.",
    hint: "For a chart node, `knime node image <node> --enable` adds it and turns image generation on.",
  },
  {
    code: "NO_IMAGE_SETTING", exit: EXIT.REJECTED,
    cause: "--enable needs the node's generateImage setting, which KNIME's current chart nodes have.",
    hint: "Check with `knime node settings <node> --filter generateImage`; other nodes can't make images.",
  },
  {
    code: "NO_INSTANCE", exit: EXIT.UNAVAILABLE,
    cause: "No running KNIME with the knime-cli plugin was found (or none with the requested pid).",
    hint: "Start KNIME with the plugin and open a workflow; `knime status` lists what it finds.",
  },
];

function statusOf(e: unknown): number | "rpc" | "net" | undefined {
  if (e instanceof HttpError) return e.status;
  if (e instanceof RpcError) return "rpc";
  if (e instanceof TypeError && /fetch failed/i.test(e.message)) return "net";
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return "net";
  return undefined;
}

/** Any thrown value as a CliError; `context` (e.g. "set hs:reader") prefixes the message. */
export function translate(e: unknown, context?: string): CliError {
  if (e instanceof CliError) return e;
  const status = statusOf(e);
  const message = e instanceof Error ? e.message : String(e);
  const prefix = context ? `${context}: ` : "";
  for (const t of TRANSLATIONS) {
    if (t.status !== status) continue;
    if (t.match && !t.match.test(message)) continue;
    return new CliError({
      code: t.code, exit: t.exit, message: prefix + message, cause: t.cause, hint: t.hint,
      status: typeof status === "number" ? status : undefined,
    });
  }
  return new CliError({
    code: "ERROR", exit: EXIT.ERROR, message: prefix + message,
    status: typeof status === "number" ? status : undefined,
  });
}

/** Hints for node messages (warnings and errors shown on a node), matched loosely. */
export function nodeMessageHint(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (/"~"|'~'|\bunexpected token\b.*~/i.test(text)) return "Java Snippet expressions need a full statement, e.g. `return $a$ / $b$;`.";
  if (/no column (spec|available)|input table|no input/i.test(text)) return "Connect its input and run upstream first.";
  if (/target column/i.test(text)) return "Set the target column explicitly; learners guess it.";
  if (/split ?criterion/i.test(text)) return "A fresh tree learner needs its missing keys created with typed values in one set: use the `regression` preset (`knime nodes info rf-learn`).";
  if (/index (\d+) out of bounds for length \1/i.test(text)) return "On a gradient boosted trees learner this means alphaFraction is 1.0; keep it below 1 (default 0.95).";
  if (/\[0, ?1\]|between 0 and 1|normali[sz]/i.test(text)) return "RProp MLP needs its target scaled to [0,1]; add a Normalizer (min-max).";
  return undefined;
}
