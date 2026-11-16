import type { Command } from "../cli.ts";
import { guide } from "./guide.ts";
import { nodesInfo, nodesSearch } from "./nodes.ts";
import { status } from "./status.ts";
import { workflowShow } from "./workflow.ts";

/** In help order: bootstrap, read, write, execute. */
export const COMMANDS: readonly Command[] = [
  guide, status, workflowShow, nodesSearch, nodesInfo,
];
