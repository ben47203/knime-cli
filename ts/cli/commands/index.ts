import type { Command } from "../cli.ts";
import { guide } from "./guide.ts";
import { nodeAdd, nodeConnect, nodeLabel, nodeRm, nodeSet, nodeSettings } from "./node.ts";
import { nodesInfo, nodesSearch } from "./nodes.ts";
import { status } from "./status.ts";
import { workflowShow } from "./workflow.ts";

/** In help order: bootstrap, read, write, execute. */
export const COMMANDS: readonly Command[] = [
  guide, status, workflowShow, nodeSettings, nodesSearch, nodesInfo,
  nodeAdd, nodeConnect, nodeLabel, nodeSet, nodeRm,
];
