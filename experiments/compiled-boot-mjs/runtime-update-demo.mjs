#!/usr/bin/env bun

import { runRuntimeUpdateDemo } from "./runtime-update-lib.mjs";

const result = await runRuntimeUpdateDemo();

process.stdout.write(
  [
    "LIVE RUNTIME UPDATE",
    `  before update:            ${result.beforeVersion}`,
    `  served during build:      ${result.duringBuildVersion}`,
    `  candidate promoted:       ${result.promoted}`,
    `  after promotion:          ${result.afterPromotionVersion}`,
    `  unhealthy promoted:       ${result.failedCandidatePromoted}`,
    `  unhealthy failure stage:  ${result.failedCandidateStage}`,
    `  active after failure:     ${result.afterFailureVersion}`,
  ].join("\n") + "\n",
);
