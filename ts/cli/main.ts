#!/usr/bin/env node
/** Entry point of the `knime` command. Node ≥ 23.6 runs this TypeScript directly in development; npm installs the built JS. */
import { main } from "./cli.ts";
import { COMMANDS } from "./commands/index.ts";

process.exitCode = await main(COMMANDS, process.argv.slice(2));
