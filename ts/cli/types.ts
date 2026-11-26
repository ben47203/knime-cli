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
  /** `dirty` (unsaved changes) is null for a project that isn't loaded. */
  projects: { projectId: string; name: string | null; dirty?: boolean | null }[];
}

/** `/api/project/state`, and `/api/project/save` with `saved: true`. */
export interface ProjectState {
  projectId: string;
  name: string;
  dirty: boolean;
  path?: string;
  canSave: boolean;
  /** Why `canSave` is false. */
  saveBlocked?: string;
  /** Present while any node executes. */
  executing?: true;
  saved?: true;
}

export interface PortEnt {
  index: number;
  name?: string;
  typeId?: string;
  info?: string;
  optional?: boolean;
  connectedVia?: string[];
  /** The extendable port group the port belongs to, e.g. "Output Image". */
  portGroupId?: string;
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

/** One workflow annotation (`/api/workflow` → `workflow.workflowAnnotations`). Ids are `<workflowId>_<index>`. */
export interface WorkflowAnnotationEnt {
  id: string;
  bounds: { x: number; y: number; width: number; height: number };
  /** HTML once written by the modern UI or a gateway command; plain text in old workflows. */
  text?: { value?: string; contentType?: string };
  borderColor?: string;
  backgroundColor?: string;
  borderWidth?: number;
}

export interface WorkflowRead {
  contentHash: string;
  workflow: {
    nodes?: Record<string, WorkflowNode>;
    workflowAnnotations?: WorkflowAnnotationEnt[];
    connections?: Record<string, Connection>;
    nodeTemplates?: Record<string, { name?: string }>;
  };
}

export interface WorkflowState {
  stateHash: string;
  /** Unsaved changes anywhere in the project, even when a metanode is addressed. */
  dirty?: boolean;
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

/** A non-JSON `/api/*` response, such as an image. */
export interface BinaryResponse {
  contentType: string;
  bytes: Buffer;
}

/** One column of a table spec. */
export interface ColumnSpec {
  name: string;
  /** KNIME's display name of the type, e.g. `String`, `Number (Integer)`, `Number (Float)`. */
  type: string;
  domain?: { values?: Json[]; valuesTruncated?: boolean; valueCount?: number; lower?: Json; upper?: Json };
}

/** A port spec: tables in full, flow-variable ports with no variables, images with their format, others by kind. */
export interface PortSpec {
  /** "table", "image", "flowVariables", "inactive", or another port type's name. */
  kind: string;
  /** Tables only. */
  columns?: ColumnSpec[];
  /** Images only: "png" or "svg". */
  format?: string;
}

export interface PortEnd {
  nodeId: string;
  index: number;
}

interface PortBase {
  index: number;
  name?: string;
  /** Port type name, e.g. `Table`, `Flow Variable`, `Image`. */
  type: string;
  optional?: true;
  /** Null until known (the node, or for an input its predecessor, isn't configured); `reason` says why. */
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

/** `/api/node/ports`: port 0 is the flow-variable port (metanodes have none). */
export interface NodePorts {
  nodeId: string;
  inputs: InputPort[];
  outputs: OutputPort[];
}

/** The calls the CLI needs from a KNIME connection; KnimeClient implements it, tests mock it. */
export interface Transport {
  status(): Promise<Status>;
  api<T = unknown>(path: string, body?: Record<string, unknown>): Promise<T>;
  /** An `/api/*` route answering with raw bytes (errors still come back as JSON). */
  apiBytes(path: string, body?: Record<string, unknown>): Promise<BinaryResponse>;
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}
