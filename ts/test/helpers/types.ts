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
  /** Whether the whole project has unsaved changes. */
  dirty: boolean;
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
  /** `dirty` is null for a project that isn't loaded. */
  projects: { projectId: string; name: string | null; dirty: boolean | null }[];
}

/** `/api/project/state`, and `/api/project/save` with `saved: true`. */
export interface ProjectState {
  projectId: string;
  name: string;
  dirty: boolean;
  path?: string;
  canSave: boolean;
  /** Why `canSave` is false; absent when it is true. */
  saveBlocked?: string;
  /** Present (true) while any node executes. */
  executing?: true;
  saved?: true;
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
  /** False if the node failed to save its own settings, so `model` stops at the last key it wrote. */
  complete: boolean;
  /** Why `complete` is false; absent otherwise. */
  problem?: string;
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
  /** As in `Settings`, for the settings read back after the set. */
  complete: boolean;
  problem?: string;
  model: JsonObject;
  redacted: string[];
}

/** One column of a table spec. */
export interface ColumnSpec {
  name: string;
  /** KNIME's display name of the type, e.g. `String`, `Number (Integer)`. */
  type: string;
  domain?: {
    /** Possible values of a nominal column, at most 50; `valuesTruncated` and `valueCount` say when there were more. */
    values?: Json[];
    valuesTruncated?: boolean;
    valueCount?: number;
    lower?: Json;
    upper?: Json;
  };
}

/** A port spec: tables in full, flow-variable ports with no variables, anything else by kind only. */
export type PortSpec =
  | { kind: "table"; columns: ColumnSpec[] }
  | { kind: "flowVariables" }
  | { kind: "inactive" }
  | { kind: string; columns?: never };

/** The other end of a connection. */
export interface PortEnd {
  nodeId: string;
  index: number;
}

interface PortBase {
  index: number;
  name?: string;
  /** Port type name, e.g. `Table`, `Flow Variable`. */
  type: string;
  optional?: true;
  /** Null until the spec is known (the node, or for an input its predecessor, isn't configured); see `reason`. */
  spec: PortSpec | null;
  reason?: string;
  summary?: string;
}

export interface InputPort extends PortBase {
  connected: boolean;
  connectedFrom?: PortEnd;
}

export interface OutputPort extends PortBase {
  connectedTo: PortEnd[];
}

/** `/api/node/ports` */
export interface NodePorts {
  nodeId: string;
  inputs: InputPort[];
  outputs: OutputPort[];
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
