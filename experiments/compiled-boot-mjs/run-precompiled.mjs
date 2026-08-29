#!/usr/bin/env bun

import { parseOptions, printResult, runPrecompiled } from "./lib.mjs";

const options = parseOptions(process.argv.slice(2));
printResult(await runPrecompiled(options), options.json);
