/**
 * Response shapes of the plugin's local API, as the server sends them (see the *Api.java sources). Fields the server
 * has no value for are omitted rather than sent as null, hence the optional properties.
 */

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

export interface OutPort {
  index: number;
  type: string;
  summary?: string;
  inactive: boolean;
}

/** `/api/node/status` */
export interface NodeStatus extends NodeState {
  outPorts: OutPort[];
}

/** `/api/workflow/state` */
export interface WorkflowState {
  stateHash: string;
  nodes: NodeState[];
}

/** `/api/workflow/errors` */
export interface WorkflowErrors {
  errors: number;
  warnings: number;
  nodes: NodeState[];
}

/** `/api/projects` */
export interface Projects {
  projects: { projectId: string; name: string | null }[];
}

/** One node of the gateway workflow entity; only the fields the tests use. */
export interface WorkflowNode {
  id: string;
  kind?: string;
  position?: { x: number; y: number };
}

/** `/api/workflow` */
export interface WorkflowRead {
  contentHash: string;
  workflow: {
    nodes?: Record<string, WorkflowNode>;
    connections?: Record<string, { sourceNode: string; destNode: string; sourcePort: number; destPort: number }>;
  };
}

/** `/api/execute` and `/api/wait` */
export interface ExecResult {
  done: boolean;
  states: Record<string, State>;
  failed: { nodeId: string; name: string; message?: Message }[];
}

/** `/api/cancel` and `/api/reset` */
export interface StatesResult {
  states: Record<string, State>;
}

/** JSON value as the settings endpoints return it. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** `/api/node/settings` */
export interface Settings {
  nodeId: string;
  kind: "native" | "component";
  model: JsonObject;
  variables: JsonObject;
  /** JSON Pointers (e.g. `/model/password`) of secrets replaced by `{"$redacted": true}`. */
  redacted: string[];
}

/** `/api/node/settings/set` */
export interface SetResult {
  changed: boolean;
  nodeId: string;
  state: State;
  message?: Message;
  model: JsonObject;
  redacted: string[];
}

/** Result of the gateway's `add_node` command. */
export interface AddNodeResult {
  kind: string;
  newNodeId: string;
}

/** Result of the gateway's `collapse` command. */
export interface CollapseResult {
  kind: string;
  newNodeId: string;
}

/** `/status` (the client's `Status` plus nothing else today; re-exported for one import site). */
export type { Status } from "../../src/client.ts";
