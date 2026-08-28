#!/usr/bin/env bun

import { parseOptions, printResult, runCloneAndCompile } from "./lib.mjs";

const options = parseOptions(process.argv.slice(2));
printResult(await runCloneAndCompile(options), options.json);
