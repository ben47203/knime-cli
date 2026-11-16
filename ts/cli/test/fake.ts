/**
 * An in-memory stand-in for the plugin's API, just faithful enough for the CLI: nodes with labels, ports and
 * settings, connections, workflow commands, settings get/set and execution. Behaviour the CLI must cope with is
 * switchable: settings that only appear once the input ran, nodes that stay IDLE while execute reports done, and
 * gateway timeouts.
 */
import { HttpError, RpcError } from "../../src/client.ts";
import { Session } from "../session.ts";
import type { Connection, ExecResult, Json, JsonObject, State, Status, Transport, WorkflowRead } from "../types.ts";

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
}

export class FakeKnime implements Transport {
  nodes = new Map<string, FakeNode>();
  connections: Connection[] = [];
  next = 1;
  calls: { method: string; body: Record<string, unknown> }[] = [];
  /** Fail the next workflow command of this kind with HTTP 504 (after applying it). */
  timeoutNext?: string;
  /** Per-factory defaults for new nodes. */
  defaults: Record<string, Partial<FakeNode>> = {};

  add(n: Partial<FakeNode> & { factory: string }): FakeNode {
    const id = `root:${this.next++}`;
    const node: FakeNode = {
      id, name: n.factory.split(".").pop()!, state: "CONFIGURED", model: {}, inPorts: 2, outPorts: 2, x: 0,
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

  async status(): Promise<Status> {
    return { apiVersion: 2, knimeVersion: "5.12.0", pid: 1, ready: true };
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
        return { projects: [{ projectId: "p1", name: "Test" }] };
      case "/api/workflow": {
        const nodes: WorkflowRead["workflow"]["nodes"] = {};
        for (const n of this.nodes.values()) {
          nodes[n.id] = {
            id: n.id, kind: "node", templateId: n.factory, position: { x: n.x, y: 0 },
            annotation: n.label ? { text: { value: n.label, contentType: "text/plain" } } : undefined,
            inPorts: Array.from({ length: n.inPorts }, (_, index) => ({ index })),
            outPorts: Array.from({ length: n.outPorts }, (_, index) => ({ index })),
          };
        }
        return { contentHash: "h", workflow: { nodes, connections: Object.fromEntries(this.connections.map((c) => [c.id, c])) } };
      }
      case "/api/workflow/state":
        return { stateHash: "s", nodes: [...this.nodes.values()].map((n) => ({ nodeId: n.id, name: n.name, state: n.state })) };
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
    if (this.timeoutNext === cmd.kind) {
      this.timeoutNext = undefined;
      throw new HttpError(504, "KNIME didn't confirm within 30000 ms");
    }
    return result as T;
  }

  #command(cmd: Record<string, unknown>): unknown {
    switch (cmd.kind) {
      case "add_node": {
        const n = this.add({ factory: (cmd.nodeFactory as { className: string }).className, x: (cmd.position as { x: number })?.x ?? 0 });
        return { kind: "add_node", newNodeId: n.id };
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
      case "delete": {
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
