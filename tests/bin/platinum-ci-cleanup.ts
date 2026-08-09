#!/usr/bin/env bun
import { cleanupPlatinumCiSandboxes } from '../src/core/platinum-ci';

await cleanupPlatinumCiSandboxes({
  apiUrl: process.env.PLATINUM_API_URL || 'https://api.platinum.dev',
  apiKey: process.env.PLATINUM_API_KEY || '',
  runId: process.env.GITHUB_RUN_ID || '',
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
});
