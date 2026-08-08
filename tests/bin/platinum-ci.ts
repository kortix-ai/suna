#!/usr/bin/env bun
import { resolve } from 'node:path';
import { runPlatinumCi } from '../src/core/platinum-ci';

const root = resolve(import.meta.dir, '../..');
const sha = process.env.PLATINUM_TEST_SHA ?? '';
const ref = process.env.PLATINUM_TEST_REF ?? sha;

process.exitCode = await runPlatinumCi({
  apiUrl: process.env.PLATINUM_API_URL || 'https://api.platinum.dev',
  apiKey: process.env.PLATINUM_API_KEY || '',
  repository: process.env.GITHUB_REPOSITORY || 'kortix-ai/suna',
  sha,
  ref,
  runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}`,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || '1',
  testArgs: process.argv.slice(2),
  root,
});
