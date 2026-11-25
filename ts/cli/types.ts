/**
 * Response shapes of the plugin's local API, as far as the CLI uses them. Mirrors ts/test/helpers/types.ts (kept
 * separate so the CLI doesn't import from the test suite), plus the workflow-entity fields the CLI reads.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type State = "IDLE" | "CONFIGURED" | "QUEUED" | "EXECUTING" | "EXECUTED" | "HALTED";

export interface Message {
  type: "WARNING" | "ERROR";
  text: string;
  issue?: string;
  resolutions?: string[];
}

export interface NodeState {
  nodeId: string;
  name: string;
  state: State;
  message?: Message;
  progressMessage?: string;
  lastExecutionMs?: number;
}

export interface Status {
  apiVersion: number;
  knimeVersion: string;
  pid: number;
  ready: boolean;
  /** Whether each KNIME internal the plugin reaches by reflection was found (e.g. `workflowSvg`). */
  capabilities?: Record<string, boolean>;
  /** Why, for each capability that is false. */
  capabilityProblems?: Record<string, string>;
}

export interface Projects {
  projects: { projectId: string; name: string | null }[];
}

export interface PortEnt {
  index: number;
  name?: string;
  typeId?: string;
  info?: string;
  optional?: boolean;
  connectedVia?: string[];
}

/** One node of the gateway workflow entity (`/api/workflow`). */
export interface WorkflowNode {
  id: string;
  kind?: string; // "node" | "metanode" | "component"
  name?: string; // metanodes and components
  templateId?: string; // native nodes: the factory class name
  position?: { x: number; y: number };
  annotation?: { text?: { value?: string; contentType?: string } };
  inPorts?: PortEnt[];
  outPorts?: PortEnt[];
}

export interface Connection {
  id?: string;
  sourceNode: string;
  sourcePort: number;
  destNode: string;
  destPort: number;
}

export interface WorkflowRead {
  contentHash: string;
  workflow: {
    nodes?: Record<string, WorkflowNode>;
    connections?: Record<string, Connection>;
    nodeTemplates?: Record<string, { name?: string }>;
  };
}

export interface WorkflowState {
  stateHash: string;
  nodes: NodeState[];
}

export interface WorkflowErrors {
  errors: number;
  warnings: number;
  nodes: NodeState[];
}

export interface ExecResult {
  done: boolean;
  states: Record<string, State>;
  failed: { nodeId: string; name: string; message?: Message }[];
}

export interface Settings {
  nodeId: string;
  kind: "native" | "component";
  model: JsonObject;
  variables: JsonObject;
  redacted: string[];
  /** Added by a pending server fix: false when the node's own save threw and `model` is cut short. */
  complete?: boolean;
  /** With complete: false, the exception and the last key written. */
  problem?: string;
}

export interface SetResult {
  changed: boolean;
  nodeId: string;
  state: State;
  message?: Message;
  model: JsonObject;
  redacted: string[];
  complete?: boolean;
  problem?: string;
}

/** The two calls the CLI needs from a KNIME connection; KnimeClient implements it, tests mock it. */
export interface Transport {
  status(): Promise<Status>;
  api<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}
