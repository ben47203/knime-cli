#!/usr/bin/env node
/** Entry point of the `knime` command. Node ≥ 23.6 runs this TypeScript directly. */
import { main } from "./cli.ts";
import { COMMANDS } from "./commands/index.ts";

process.exitCode = await main(COMMANDS, process.argv.slice(2));
