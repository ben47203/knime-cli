/**
 * An in-memory stand-in for the plugin's API, just faithful enough for the CLI: nodes with labels, ports and
 * settings, connections, workflow commands, settings get/set and execution. Behaviour the CLI must cope with is
 * switchable: settings that only appear once the input ran, nodes that stay IDLE while execute reports done, and
 * gateway timeouts.
 */
import { HttpError, RpcError } from "../../src/client.ts";
import { Session } from "../session.ts";
import type {
  BinaryResponse, ColumnSpec, Connection, ExecResult, Json, JsonObject, State, Status, Transport, WorkflowAnnotationEnt, WorkflowRead,
} from "../types.ts";

export interface FakeNode {
  id: string;
  factory: string;
  name: string;
  label?: string;
  state: State;
  model: JsonObject;
  /** Settings the node shows only once its inputs executed (like most nodes with inputs). */
  modelWhenFed?: JsonObject;
  /** Stays IDLE when executed (never configured). */
  staysIdle?: boolean;
  /** Reads as complete: false until a set creates `completesWith` (like a fresh tree learner). */
  completesWith?: string;
  inPorts: number;
  outPorts: number;
  x: number;
  y: number;
  /** The table spec of every data output, known once the node has executed. */
  columns?: ColumnSpec[];
  /** Output ports that are image ports ("Output Image" group). */
  imagePorts?: number[];
}

export const IMAGE_PORT_TYPE = "org.knime.core.node.port.image.ImagePortObject";

export class FakeKnime implements Transport {
  nodes = new Map<string, FakeNode>();
  connections: Connection[] = [];
  /** Back to front, like the gateway. Ids are `root_<n>`, the lowest free n, so they're reused after a delete. */
  annotations: WorkflowAnnotationEnt[] = [];
  next = 1;
  calls: { method: string; body: Record<string, unknown> }[] = [];
  /** Fail the next workflow command of this kind with HTTP 504 (after applying it). */
  timeoutNext?: string;
  /** Per-factory defaults for new nodes. */
  defaults: Record<string, Partial<FakeNode>> = {};
  /** Unsaved changes: set by every workflow command and settings change. */
  dirty = false;
  /** Why the project can't be saved in place, if it can't. */
  saveBlocked?: string;
  saves = 0;

  add(n: Partial<FakeNode> & { factory: string }): FakeNode {
    const id = `root:${this.next++}`;
    const node: FakeNode = {
      id, name: n.factory.split(".").pop()!, state: "CONFIGURED", model: {}, inPorts: 2, outPorts: 2, x: 0, y: 0,
      ...this.defaults[n.factory], ...n,
    };
    node.id = id;
    this.nodes.set(id, node);
    return node;
  }

  connect(from: string, fromPort: number, to: string, toPort: number): void {
    this.connections = this.connections.filter((c) => !(c.destNode === to && c.destPort === toPort));
    this.connections.push({ id: `${to}_${toPort}`, sourceNode: from, sourcePort: fromPort, destNode: to, destPort: toPort });
  }

  /** What /status reports as capabilities. */
  capabilities: Record<string, boolean> = { settingsSaveCheck: true, saveRefreshesUi: true, workflowSvg: true };

  /** An annotation as KNIME would hold it after add + update. */
  annotate(a: { text?: string; contentType?: string; bounds?: WorkflowAnnotationEnt["bounds"]; borderColor?: string }): WorkflowAnnotationEnt {
    const ent: WorkflowAnnotationEnt = {
      id: this.#freeAnnotationId(), bounds: a.bounds ?? { x: 0, y: 0, width: 100, height: 50 },
      text: { value: a.text ?? "", contentType: a.contentType ?? "text/html" },
      borderColor: a.borderColor ?? "#C0C4C6", backgroundColor: "#FFFFFF", borderWidth: 10,
    };
    this.annotations.push(ent);
    return ent;
  }

  #freeAnnotationId(): string {
    const used = new Set(this.annotations.map((a) => a.id));
    let i = 0;
    while (used.has(`root_${i}`)) i++;
    return `root_${i}`;
  }

  #annotation(id: unknown): WorkflowAnnotationEnt {
    const a = this.annotations.find((x) => x.id === String(id));
    if (!a) throw new RpcError(-32600, `Annotation not found\n * No workflow annotation found for id ${String(id)}`, null);
    return a;
  }

  async status(): Promise<Status> {
    const problems = Object.entries(this.capabilities).filter(([, v]) => !v).map(([k]) => [k, `${k} not found`]);
    return { apiVersion: 2, knimeVersion: "5.12.0", pid: 1, ready: true, capabilities: this.capabilities, ...(problems.length ? { capabilityProblems: Object.fromEntries(problems) } : {}) };
  }

  async apiBytes(path: string, body: Record<string, unknown> = {}): Promise<BinaryResponse> {
    this.calls.push({ method: path, body });
    switch (path) {
      case "/api/node/port/image": {
        const n = this.#node(body.nodeId);
        const port = Number(body.port);
        if (!n.imagePorts?.includes(port)) throw new HttpError(400, `Output port ${port} of ${n.name} is a Table port, not an image port`);
        if (n.state !== "EXECUTED") throw new HttpError(409, `Output port ${port} of ${n.name} holds no image until the node executes (it is ${n.state})`);
        const svg = n.model.imageFormat === "SVG";
        if (svg) return { contentType: "image/svg+xml", bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n.model.width}" height="${n.model.height}"/>`) };
        const png = Buffer.alloc(33);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(png);
        png.writeUInt32BE(Number(n.model.width), 16);
        png.writeUInt32BE(Number(n.model.height), 20);
        return { contentType: "image/png", bytes: png };
      }
      case "/api/workflow/svg":
        return { contentType: "image/svg+xml; charset=utf-8", bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120"><text>${this.nodes.size} nodes</text></svg>`) };
      default:
        throw new HttpError(404, `No route ${path}`);
    }
  }

  async api<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method: path, body });
    return this.#api(path, body) as T;
  }

  #node(id: unknown): FakeNode {
    const n = this.nodes.get(String(id));
    if (!n) throw new HttpError(404, `No node ${String(id)}`);
    return n;
  }

  #fed(n: FakeNode): boolean {
    const ins = this.connections.filter((c) => c.destNode === n.id);
    return ins.length > 0 && ins.every((c) => this.nodes.get(c.sourceNode)?.state === "EXECUTED");
  }

  #model(n: FakeNode): JsonObject {
    return n.modelWhenFed && this.#fed(n) ? { ...n.modelWhenFed, ...n.model } : n.model;
  }

  #api(path: string, body: Record<string, unknown>): unknown {
    switch (path) {
      case "/api/projects":
        return { projects: [{ projectId: "p1", name: "Test", dirty: this.dirty }] };
      case "/api/project/state":
      case "/api/project/save": {
        if (Object.keys(body).some((k) => k !== "projectId")) throw new HttpError(400, `Unknown field(s) in ${Object.keys(body).join(", ")}`);
        if (body.projectId !== "p1") throw new HttpError(404, `No open project with id ${String(body.projectId)}`);
        if (path === "/api/project/save") {
          if (this.saveBlocked) throw new HttpError(409, `Can't save Test: ${this.saveBlocked}`);
          this.dirty = false;
          this.saves++;
        }
        return {
          projectId: "p1", name: "Test", dirty: this.dirty, path: "/ws/Test", canSave: !this.saveBlocked,
          ...(this.saveBlocked ? { saveBlocked: this.saveBlocked } : {}), ...(path === "/api/project/save" ? { saved: true } : {}),
        };
      }
      case "/api/workflow": {
        const nodes: WorkflowRead["workflow"]["nodes"] = {};
        for (const n of this.nodes.values()) {
          nodes[n.id] = {
            id: n.id, kind: "node", templateId: n.factory, position: { x: n.x, y: n.y },
            annotation: n.label ? { text: { value: n.label, contentType: "text/plain" } } : undefined,
            inPorts: Array.from({ length: n.inPorts }, (_, index) => ({ index })),
            outPorts: Array.from({ length: n.outPorts }, (_, index) => (n.imagePorts?.includes(index)
              ? { index, name: "Output Image", typeId: IMAGE_PORT_TYPE, portGroupId: "Output Image" } : { index })),
          };
        }
        return {
          contentHash: "h",
          workflow: { nodes, connections: Object.fromEntries(this.connections.map((c) => [c.id, c])), workflowAnnotations: this.annotations.map(knimeOrder) },
        };
      }
      case "/api/workflow/state":
        return { stateHash: "s", dirty: this.dirty, nodes: [...this.nodes.values()].map((n) => ({ nodeId: n.id, name: n.name, state: n.state })) };
      case "/api/node/ports": {
        const n = this.#node(body.nodeId);
        const out = (m: FakeNode, i: number) => {
          if (i === 0) return { spec: { kind: "flowVariables" } };
          if (m.imagePorts?.includes(i)) return m.state === "EXECUTED" ? { spec: { kind: "image", format: "png" } } : { spec: null, reason: "no spec until the node executes" };
          return m.state === "EXECUTED" && m.columns ? { spec: { kind: "table", columns: m.columns } } : { spec: null, reason: "no spec until the node executes" };
        };
        return {
          nodeId: n.id,
          inputs: Array.from({ length: n.inPorts }, (_, index) => {
            const c = this.connections.find((x) => x.destNode === n.id && x.destPort === index);
            const src = c && this.nodes.get(c.sourceNode);
            const spec = index === 0 ? { spec: { kind: "flowVariables" } } : src ? out(src, c.sourcePort) : { spec: null, reason: "not connected" };
            return { index, type: index === 0 ? "Flow Variable" : "Table", connected: Boolean(c), ...(c ? { connectedFrom: { nodeId: c.sourceNode, index: c.sourcePort } } : {}), ...spec };
          }),
          outputs: Array.from({ length: n.outPorts }, (_, index) => ({
            index, type: index === 0 ? "Flow Variable" : n.imagePorts?.includes(index) ? "Image" : "Table",
            ...(n.imagePorts?.includes(index) ? { name: "Output Image" } : {}),
            connectedTo: this.connections.filter((x) => x.sourceNode === n.id && x.sourcePort === index).map((x) => ({ nodeId: x.destNode, index: x.destPort })),
            ...out(n, index),
          })),
        };
      }
      case "/api/workflow/errors":
        return { errors: 0, warnings: 0, nodes: [] };
      case "/api/node/settings": {
        const n = this.#node(body.nodeId);
        return { nodeId: n.id, kind: "native", ...this.#completeness(n), model: this.#model(n), variables: {}, redacted: [] };
      }
      case "/api/node/settings/set": {
        const n = this.#node(body.nodeId);
        const model = structuredClone(this.#model(n));
        const changed = merge(model, body.model as JsonObject, "");
        if (changed) {
          n.model = model;
          this.dirty = true;
          for (const id of [n.id, ...this.#downstream(n.id)]) {
            const d = this.nodes.get(id)!;
            if (d.state === "EXECUTED") d.state = "CONFIGURED";
          }
        }
        return { changed, nodeId: n.id, state: n.state, ...this.#completeness(n), model, redacted: [] };
      }
      case "/api/execute": {
        const targets = (body.nodeIds as string[] | undefined) ?? [...this.nodes.keys()];
        const all = new Set<string>();
        for (const t of targets) for (const id of [t, ...this.#upstream(t)]) all.add(id);
        for (const id of all) {
          const n = this.#node(id);
          if (!n.staysIdle) n.state = "EXECUTED";
          else n.state = "IDLE";
        }
        return this.#exec(targets);
      }
      case "/api/wait":
        return this.#exec((body.nodeIds as string[] | undefined) ?? [...this.nodes.keys()]);
      case "/api/cancel":
        return { states: {} };
      default:
        throw new HttpError(404, `No route ${path}`);
    }
  }

  #completeness(n: FakeNode): { complete: boolean; problem?: string } {
    return n.completesWith && !(n.completesWith in n.model)
      ? { complete: false, problem: `save failed after nrModels; ${n.completesWith} is missing` } : { complete: true };
  }

  #exec(targets: string[]): ExecResult {
    // Like the real server: done, nothing failed, even if nodes stayed IDLE.
    return { done: true, states: Object.fromEntries(targets.map((t) => [t, this.#node(t).state])), failed: [] };
  }

  #upstream(id: string): string[] {
    const out: string[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const c of this.connections) if (c.destNode === cur && !out.includes(c.sourceNode)) { out.push(c.sourceNode); queue.push(c.sourceNode); }
    }
    return out;
  }

  #downstream(id: string): string[] {
    const out: string[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const c of this.connections) if (c.sourceNode === cur && !out.includes(c.destNode)) { out.push(c.destNode); queue.push(c.destNode); }
    }
    return out;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, body: params });
    if (method !== "WorkflowService.executeWorkflowCommand") throw new RpcError(-32001, "Method not allowed", null);
    const cmd = params.workflowCommand as Record<string, unknown>;
    const result = this.#command(cmd);
    this.dirty = true;
    if (this.timeoutNext === cmd.kind) {
      this.timeoutNext = undefined;
      throw new HttpError(504, "KNIME didn't confirm within 30000 ms");
    }
    return result as T;
  }

  #command(cmd: Record<string, unknown>): unknown {
    switch (cmd.kind) {
      case "add_node": {
        const pos = cmd.position as { x: number; y: number } | undefined;
        const n = this.add({ factory: (cmd.nodeFactory as { className: string }).className, x: pos?.x ?? 0, y: pos?.y ?? 0 });
        return { kind: "add_node", newNodeId: n.id };
      }
      case "add_port": {
        const n = this.#node(cmd.nodeId);
        if (cmd.side !== "output" || cmd.portGroup !== "Output Image") throw new RpcError(-32600, `No port group ${String(cmd.portGroup)}`, null);
        n.imagePorts = [...(n.imagePorts ?? []), n.outPorts];
        n.outPorts++;
        n.state = "CONFIGURED";
        return { kind: "add_port_result", newPortIdx: n.outPorts - 1 };
      }
      case "update_node_label":
        this.#node(cmd.nodeId).label = String(cmd.label);
        return {};
      case "connect": {
        const src = this.#node(cmd.sourceNodeId);
        const dst = this.#node(cmd.destinationNodeId);
        if (Number(cmd.sourcePortIdx) >= src.outPorts || Number(cmd.destinationPortIdx) >= dst.inPorts) {
          throw new RpcError(-32600, "Connection could not be created", null);
        }
        this.connect(src.id, Number(cmd.sourcePortIdx), dst.id, Number(cmd.destinationPortIdx));
        return {};
      }
      case "add_workflow_annotation": {
        const a = this.annotate({ bounds: cmd.bounds as WorkflowAnnotationEnt["bounds"], borderColor: hexColour(cmd.borderColor) });
        return { kind: "add_annotation_result", newAnnotationId: a.id, snapshotId: "1" };
      }
      case "update_workflow_annotation": {
        const a = this.#annotation(cmd.annotationId);
        if (cmd.text == null && cmd.borderColor == null) throw new RpcError(-32600, "Failed to update annotation", null);
        if (cmd.text != null) a.text = { value: String(cmd.text), contentType: "text/html" };
        else a.text = { value: a.text?.value ?? "", contentType: "text/html" };
        if (cmd.borderColor != null) a.borderColor = hexColour(cmd.borderColor);
        return null;
      }
      case "transform_workflow_annotation":
        this.#annotation(cmd.annotationId).bounds = structuredClone(cmd.bounds as WorkflowAnnotationEnt["bounds"]);
        return null;
      case "reorder_workflow_annotations": {
        const ids = (cmd.annotationIds as string[]).map((id) => this.#annotation(id).id);
        const moving = this.annotations.filter((a) => ids.includes(a.id));
        const rest = this.annotations.filter((a) => !ids.includes(a.id));
        if (cmd.action === "send_to_back") this.annotations = [...moving, ...rest];
        else if (cmd.action === "bring_to_front") this.annotations = [...rest, ...moving];
        else throw new RpcError(-32600, `fake: reorder ${String(cmd.action)} not modelled`, null);
        return null;
      }
      case "delete": {
        for (const id of (cmd.annotationIds as string[] | undefined) ?? []) this.#annotation(id);
        this.annotations = this.annotations.filter((a) => !((cmd.annotationIds as string[] | undefined) ?? []).includes(a.id));
        for (const id of cmd.nodeIds as string[]) this.nodes.delete(id);
        const gone = new Set(cmd.connectionIds as string[]);
        this.connections = this.connections.filter((c) => !gone.has(c.id!) && this.nodes.has(c.sourceNode) && this.nodes.has(c.destNode));
        return {};
      }
      default:
        throw new RpcError(-32600, `Unknown command ${String(cmd.kind)}`, null);
    }
  }

  session(): Session {
    return new Session(this);
  }

  commands(kind?: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === "WorkflowService.executeWorkflowCommand")
      .map((c) => c.body.workflowCommand as Record<string, unknown>)
      .filter((c) => !kind || c.kind === kind);
  }
}

/** The gateway's JSON lists bounds as width, y, height, x; keep that, so nothing relies on key order. */
function knimeOrder(a: WorkflowAnnotationEnt): WorkflowAnnotationEnt {
  const { x, y, width, height } = a.bounds;
  return { ...structuredClone(a), bounds: { width, y, height, x } };
}

/** Like the gateway's Integer.decode: hex with # or 0x, else "Failed to parse color". Read back as #RRGGBB. */
function hexColour(c: unknown): string | undefined {
  if (c == null) return undefined;
  const m = /^(?:#|0x)([0-9a-f]{1,6})$/i.exec(String(c));
  if (!m) throw new RpcError(-32600, `Failed to parse color\n * Invalid hex string <${String(c)}>`, null);
  return `#${m[1]!.padStart(6, "0").toUpperCase()}`;
}

/** Patches existing keys only, like the server; returns whether anything changed. */
function merge(target: JsonObject, patch: JsonObject, path: string): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && "$type" in v) {
      // A typed value creates or replaces the key; store what the server would read back.
      const plain = unwrap(v as Json);
      if (JSON.stringify(target[k]) !== JSON.stringify(plain)) {
        target[k] = plain;
        changed = true;
      }
      continue;
    }
    if (!(k in target)) throw new HttpError(400, `Unknown setting /model${path}/${k}; existing keys: ${Object.keys(target).join(", ")}`);
    const cur = target[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object" && !Array.isArray(cur)) {
      changed = merge(cur as JsonObject, v as JsonObject, `${path}/${k}`) || changed;
    } else if (JSON.stringify(cur) !== JSON.stringify(v)) {
      target[k] = v;
      changed = true;
    }
  }
  return changed;
}

function unwrap(v: Json): Json {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("$type" in v) return unwrap((v as { value: Json }).value);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unwrap(x)]));
  }
  return Array.isArray(v) ? v.map(unwrap) : v;
}
