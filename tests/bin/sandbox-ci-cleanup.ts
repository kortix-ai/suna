#!/usr/bin/env bun
import { cleanupDaytonaCiSandbox } from '../src/core/daytona-ci';
import { cleanupPlatinumCiSandboxes } from '../src/core/platinum-ci';

const runId = process.env.GITHUB_RUN_ID || '';
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';

const cleanups: Array<Promise<number>> = [];
if (process.env.PLATINUM_API_KEY) {
  cleanups.push(
    cleanupPlatinumCiSandboxes({
      apiUrl: process.env.PLATINUM_API_URL || 'https://api.platinum.dev',
      apiKey: process.env.PLATINUM_API_KEY,
      runId,
      runAttempt,
    }),
  );
}
if (process.env.DAYTONA_API_KEY) {
  cleanups.push(
    cleanupDaytonaCiSandbox({
      apiUrl:
        process.env.DAYTONA_API_URL ||
        process.env.DAYTONA_SERVER_URL ||
        'https://app.daytona.io/api',
      apiKey: process.env.DAYTONA_API_KEY,
      runId,
      runAttempt,
    }),
  );
}

const results = await Promise.allSettled(cleanups);

const failures = results.filter((result) => result.status === 'rejected');
for (const failure of failures) console.error(String((failure as PromiseRejectedResult).reason));
if (failures.length) process.exitCode = 1;
