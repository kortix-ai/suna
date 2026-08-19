#!/usr/bin/env bun
import { resolve } from 'node:path';
import { parseSandboxCiProvider, runSandboxCi } from '../src/core/sandbox-ci';

const root = resolve(import.meta.dir, '../..');
const sha = process.env.SANDBOX_TEST_SHA ?? '';
const ref = process.env.SANDBOX_TEST_REF ?? sha;
const repository = process.env.GITHUB_REPOSITORY || 'kortix-ai/suna';
const runId = process.env.SANDBOX_TEST_RUN_ID || process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
const testArgs = process.argv.slice(2);
const skipSdkPackageTests = process.env.KORTIX_PACKAGE_SKIP_SDK_TESTS === '1';

process.exitCode = await runSandboxCi({
  provider: parseSandboxCiProvider(process.env.TEST_SANDBOX_PROVIDER),
  platinum: {
    apiUrl: process.env.PLATINUM_API_URL || 'https://api.platinum.dev',
    apiKey: process.env.PLATINUM_API_KEY || '',
    repository,
    sha,
    ref,
    runId,
    runAttempt,
    testArgs,
    skipSdkPackageTests,
    root,
  },
  daytona: {
    apiUrl:
      process.env.DAYTONA_API_URL || process.env.DAYTONA_SERVER_URL || 'https://app.daytona.io/api',
    apiKey: process.env.DAYTONA_API_KEY || '',
    target: process.env.DAYTONA_CI_TARGET || process.env.DAYTONA_TARGET || 'us',
    repository,
    sha,
    ref,
    runId,
    runAttempt,
    testArgs,
    skipSdkPackageTests,
    root,
  },
});
