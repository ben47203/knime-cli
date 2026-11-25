import type { Command } from "../cli.ts";
import { apply } from "./apply.ts";
import { guide } from "./guide.ts";
import { nodeImage } from "./image.ts";
import { nodeAdd, nodeConnect, nodeLabel, nodePorts, nodeRm, nodeSet, nodeSettings } from "./node.ts";
import { nodesInfo, nodesSearch } from "./nodes.ts";
import { save } from "./project.ts";
import { run } from "./run.ts";
import { status } from "./status.ts";
import { workflowShow, workflowSvg } from "./workflow.ts";

/** In help order: bootstrap, read, write, execute. */
export const COMMANDS: readonly Command[] = [
  guide, status, workflowShow, workflowSvg, nodeSettings, nodePorts, nodeImage, nodesSearch, nodesInfo,
  nodeAdd, nodeConnect, nodeLabel, nodeSet, nodeRm, save, run, apply,
];
