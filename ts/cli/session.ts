/**
 * One CLI invocation's view of KNIME: which instance, which project and workflow, and node lookup by id or label.
 * Everything goes through a {@link Transport}, so tests can swap in a fake KNIME.
 */
import { KnimeClient } from "../src/client.ts";
import { listInstances, type Instance } from "../src/discovery.ts";
import { readAnnotation, type AnnotationView } from "./annotations.ts";
import { CliError, EXIT, translate } from "./errors.ts";
import { plainText, splitLabel } from "./text.ts";
import type {
  BinaryResponse, Connection, NodePorts, NodeState, Projects, Transport, WorkflowRead, WorkflowState,
} from "./types.ts";

/** The plugin API version the CLI was written against. */
export const EXPECTED_API_VERSION = 2;

export interface Target {
  projectId: string;
  workflowId: string;
}

export interface SessionOptions {
  pid?: string;
  project?: string;
  workflow?: string;
}

/** Picks the instance: `--pid`, else KNIME_CLI_PID, else the newest live one. */
export function pickInstance(instances: readonly Instance[], pid?: string): Instance {
  const wanted = pid ?? process.env.KNIME_CLI_PID;
  const found = wanted ? instances.find((i) => String(i.pid) === String(wanted)) : instances[0];
  if (!found) {
    throw new CliError({
      code: "NO_INSTANCE", exit: EXIT.UNAVAILABLE,
      message: wanted
        ? `No running KNIME instance with pid ${wanted} (found: ${instances.map((i) => i.pid).join(", ") || "none"})`
        : "No running KNIME instance found",
      hint: "Start KNIME with the knime-cli plugin installed and open a workflow, then run `knime status`.",
    });
  }
  return found;
}

export interface NodeView {
  id: string;
  /** First line of the node's annotation: what lookup, `--prefix` and `apply` match. */
  label?: string;
  /** Further lines of the annotation: a human note (`knime node note`). */
  note?: string;
  name: string;
  kind: string;
  factory?: string;
  state?: NodeState["state"];
  message?: NodeState["message"];
  position?: { x: number; y: number };
  inPorts: number;
  outPorts: number;
}

/** A read of one workflow: nodes merged with their states, and connections. */
export class Snapshot {
  readonly nodes: NodeView[];
  readonly connections: Connection[];
  /** Workflow annotations, back to front. */
  readonly annotations: AnnotationView[];
  readonly raw: WorkflowRead;
  readonly workflowId: string;
  /** The project has unsaved changes (from workflow/state); undefined if the server didn't say. */
  readonly dirty?: boolean;

  constructor(read: WorkflowRead, state: WorkflowState | undefined, workflowId: string) {
    this.raw = read;
    this.workflowId = workflowId;
    this.dirty = state?.dirty;
    const states = new Map((state?.nodes ?? []).map((n) => [n.nodeId, n]));
    const templates = read.workflow.nodeTemplates ?? {};
    this.nodes = Object.values(read.workflow.nodes ?? {}).map((n) => {
      const s = states.get(n.id);
      const { label, note } = splitLabel(plainText(n.annotation?.text));
      return {
        id: n.id,
        label,
        note,
        name: s?.name ?? n.name ?? (n.templateId ? templates[n.templateId]?.name : undefined) ?? n.kind ?? "?",
        kind: n.kind ?? "node",
        factory: n.templateId,
        state: s?.state,
        message: s?.message,
        position: n.position,
        inPorts: n.inPorts?.length ?? 0,
        outPorts: n.outPorts?.length ?? 0,
      };
    }).sort((a, b) => idOrder(a.id) - idOrder(b.id));
    this.connections = Object.values(read.workflow.connections ?? {});
    this.annotations = (read.workflow.workflowAnnotations ?? []).map(readAnnotation);
  }

  byId(id: string): NodeView | undefined {
    return this.nodes.find((n) => n.id === id);
  }

  withLabel(label: string): NodeView[] {
    return this.nodes.filter((n) => n.label === label);
  }

  withPrefix(prefix: string): NodeView[] {
    return this.nodes.filter((n) => n.label?.startsWith(prefix));
  }

  /** Nodes downstream of `id` (not including it), following connections. */
  downstream(id: string): string[] {
    const out = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const c of this.connections) {
        if (c.sourceNode === cur && !out.has(c.destNode)) {
          out.add(c.destNode);
          queue.push(c.destNode);
        }
      }
    }
    return [...out];
  }

  upstream(id: string): string[] {
    return this.connections.filter((c) => c.destNode === id).map((c) => c.sourceNode);
  }

  /**
   * A node by id (`root:7`), bare number (`7`, within this workflow) or label. Ids win over labels, and a label
   * matching more than one node is an error rather than a guess.
   */
  resolve(ref: string): NodeView {
    const asId = this.#asId(ref);
    if (asId) {
      const n = this.byId(asId);
      if (n) return n;
    }
    const labelled = this.withLabel(ref);
    if (labelled.length === 1) return labelled[0]!;
    if (labelled.length > 1) {
      throw new CliError({
        code: "AMBIGUOUS", exit: EXIT.USAGE,
        message: `Label "${ref}" is on ${labelled.length} nodes: ${labelled.map((n) => n.id).join(", ")}`,
        hint: "Use the node id, or relabel one of them with `knime node label`.",
      });
    }
    throw new CliError({
      code: "NODE_NOT_FOUND", exit: EXIT.NOT_FOUND,
      message: asId ? `No node ${asId} in workflow ${this.workflowId}` : `No node with id or label "${ref}"`,
      hint: "Run `knime workflow show` for current ids and labels. Ids are reused after deletes; prefer labels.",
    });
  }

  /**
   * `node[:port]`: the whole text is tried as a node first (labels may contain colons), then a trailing `:<n>` is
   * read as the port. Port defaults to 1, the first data port.
   */
  resolvePort(ref: string, defaultPort = 1): { node: NodeView; port: number } {
    try {
      return { node: this.resolve(ref), port: defaultPort };
    } catch (e) {
      const m = /^(.*):(\d+)$/.exec(ref);
      if (!m || (e as CliError).code === "AMBIGUOUS") throw e;
      return { node: this.resolve(m[1]!), port: Number(m[2]) };
    }
  }

  /** Annotations whose tag starts with `prefix`. */
  annotationsWithPrefix(prefix: string): AnnotationView[] {
    return this.annotations.filter((a) => a.tag?.startsWith(prefix));
  }

  /** An annotation by id (`root_3`), bare index (`3`, within this workflow) or tag; ids win, like nodes. */
  resolveAnnotation(ref: string): AnnotationView {
    const id = /^\d+$/.test(ref) ? `${this.workflowId}_${ref}` : ref;
    const byId = this.annotations.find((a) => a.id === id);
    if (byId) return byId;
    const tagged = this.annotations.filter((a) => a.tag === ref);
    if (tagged.length === 1) return tagged[0]!;
    if (tagged.length > 1) {
      throw new CliError({
        code: "AMBIGUOUS", exit: EXIT.USAGE,
        message: `Tag "${ref}" is on ${tagged.length} annotations: ${tagged.map((a) => a.id).join(", ")}`,
        hint: "Use the annotation id, or retag one of them with `knime annotate update <id> --tag <tag>`.",
      });
    }
    throw new CliError({
      code: "ANNOTATION_NOT_FOUND", exit: EXIT.NOT_FOUND,
      message: `No annotation with id or tag "${ref}" in workflow ${this.workflowId}`,
      hint: "Run `knime annotate list` for current ids and tags. Ids are reused after deletes; prefer tags.",
    });
  }

  #asId(ref: string): string | undefined {
    if (/^\d+$/.test(ref)) return `${this.workflowId}:${ref}`;
    if (/^root(:\d+)+$/.test(ref)) return ref;
    return undefined;
  }

  /** Rightmost x of the nodes not matching `exclude`, for placing new nodes beside them. */
  maxX(exclude?: (n: NodeView) => boolean): number {
    const xs = this.nodes.filter((n) => !exclude?.(n)).map((n) => n.position?.x ?? 0);
    return xs.length ? Math.max(...xs) : 0;
  }
}

function idOrder(id: string): number {
  return Number(id.split(":").pop()) || 0;
}

export class Session {
  readonly transport: Transport;
  readonly instance?: Instance;
  readonly options: SessionOptions;
  readonly notes: string[] = [];
  #target?: Promise<Target>;

  constructor(transport: Transport, options: SessionOptions = {}, instance?: Instance) {
    this.transport = transport;
    this.options = options;
    this.instance = instance;
  }

  static async connect(options: SessionOptions): Promise<Session> {
    const instance = pickInstance(await listInstances(), options.pid);
    const s = new Session(new KnimeClient(instance), options, instance);
    if (instance.apiVersion !== EXPECTED_API_VERSION) {
      s.notes.push(`plugin API v${instance.apiVersion}; this CLI was written for v${EXPECTED_API_VERSION}`);
    }
    return s;
  }

  /** The project and workflow: `--project` (id or name) or KNIME_CLI_PROJECT, else the only/first open project. */
  target(): Promise<Target> {
    // Cached as a promise, so concurrent callers share one lookup (and one note).
    return (this.#target ??= this.#findTarget());
  }

  async #findTarget(): Promise<Target> {
    const { projects } = await this.api<Projects>("/api/projects");
    const wanted = this.options.project ?? process.env.KNIME_CLI_PROJECT;
    const project = wanted ? projects.find((p) => p.projectId === wanted || p.name === wanted) : projects[0];
    if (!project) {
      throw new CliError({
        code: wanted ? "PROJECT_NOT_FOUND" : "NO_PROJECT", exit: EXIT.NOT_FOUND,
        message: wanted
          ? `No open project with id or name "${wanted}"; open: ${projects.map((p) => p.name ?? p.projectId).join(", ") || "none"}`
          : "KNIME is running but no workflow is open",
        hint: "Open a workflow in KNIME, or pass --project <id|name>.",
      });
    }
    if (!wanted) {
      this.notes.push(projects.length === 1
        ? `project "${project.name ?? project.projectId}"`
        : `project "${project.name ?? project.projectId}" (first of ${projects.length} open; pass --project to choose)`);
    }
    return { projectId: project.projectId, workflowId: this.options.workflow ?? "root" };
  }

  /** `/api/*` with the target merged in. */
  async api<T>(path: string, body: Record<string, unknown> = {}, context?: string): Promise<T> {
    const scoped = path === "/api/projects" ? body : { ...(await this.target()), ...body };
    try {
      return await this.transport.api<T>(path, scoped);
    } catch (e) {
      throw translate(e, context);
    }
  }

  /** A node's ports with their specs (column names and types), or why a spec is missing. */
  ports(nodeId: string): Promise<NodePorts> {
    return this.api<NodePorts>("/api/node/ports", { nodeId }, `ports of ${nodeId}`);
  }

  /** A binary `/api/*` route (images), with the target merged in. */
  async bytes(path: string, body: Record<string, unknown> = {}, context?: string): Promise<BinaryResponse> {
    const scoped = { ...(await this.target()), ...body };
    try {
      return await this.transport.apiBytes(path, scoped);
    } catch (e) {
      throw translate(e, context);
    }
  }

  /**
   * Fails clearly when the plugin reports a capability as missing (a KNIME internal it reaches by reflection wasn't
   * found). Older plugins report no capabilities; then the request itself decides.
   */
  async requireCapability(name: string, what: string): Promise<void> {
    let st;
    try {
      st = await this.transport.status();
    } catch (e) {
      throw translate(e, "status");
    }
    if (st.capabilities?.[name] === false) {
      throw new CliError({
        code: "CAPABILITY_MISSING", exit: EXIT.UNAVAILABLE,
        message: `This KNIME can't produce ${what}: capability ${name} is unavailable${st.capabilityProblems?.[name] ? ` (${st.capabilityProblems[name]})` : ""}`,
        hint: "The plugin couldn't reach a KNIME internal it needs in this KNIME version; `knime status --json` lists capabilities. Other commands still work.",
      });
    }
  }

  /** A project-level route (`/api/project/*`): only the projectId is merged in, as they refuse other fields. */
  async projectApi<T>(path: string, body: Record<string, unknown> = {}, context?: string): Promise<T> {
    const { projectId } = await this.target();
    try {
      return await this.transport.api<T>(path, { projectId, ...body });
    } catch (e) {
      throw translate(e, context);
    }
  }

  /** The target project's name and whether it has unsaved changes (null if KNIME doesn't know). */
  async unsaved(): Promise<{ name: string; dirty: boolean | null }> {
    const { projectId } = await this.target();
    const { projects } = await this.api<Projects>("/api/projects");
    const p = projects.find((x) => x.projectId === projectId);
    return { name: p?.name ?? projectId, dirty: p?.dirty ?? null };
  }

  /** One gateway workflow command. */
  async command<T = unknown>(workflowCommand: Record<string, unknown>, context?: string): Promise<T> {
    const target = await this.target();
    try {
      return await this.transport.call<T>("WorkflowService.executeWorkflowCommand", { ...target, workflowCommand });
    } catch (e) {
      throw translate(e, context ?? String(workflowCommand.kind));
    }
  }

  async snapshot(): Promise<Snapshot> {
    const [read, state] = await Promise.all([
      this.api<WorkflowRead>("/api/workflow"),
      this.api<WorkflowState>("/api/workflow/state"),
    ]);
    return new Snapshot(read, state, (await this.target()).workflowId);
  }
}
