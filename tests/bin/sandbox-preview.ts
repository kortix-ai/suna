#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type SandboxPreviewProvider,
  runSandboxPreview,
} from '../src/core/sandbox-preview';
import {
  type SandboxPreviewDeploymentInput,
  deployDaytonaPreview,
  deployPlatinumPreview,
  reconcileDaytonaPreviews,
  reconcilePlatinumPreviews,
  teardownDaytonaPreview,
  teardownPlatinumPreview,
} from '../src/core/sandbox-preview-providers';
import type { PreviewRuntimeSecrets } from '../src/core/preview-stack';

function value(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function required(name: string): string {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function positiveInteger(name: string): number {
  const result = Number(required(name));
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}

function provider(): SandboxPreviewProvider {
  const selected = value('PREVIEW_SANDBOX_PROVIDER', 'auto').toLowerCase();
  if (selected === 'auto' || selected === 'platinum' || selected === 'daytona') return selected;
  throw new Error(`PREVIEW_SANDBOX_PROVIDER must be auto, platinum, or daytona; received ${selected}`);
}

function runtimeSecrets(): PreviewRuntimeSecrets {
  return {
    DAYTONA_API_KEY: value('DAYTONA_API_KEY'),
    KE2E_STRIPE_SECRET_KEY: value('KE2E_STRIPE_SECRET_KEY'),
    KE2E_STRIPE_WEBHOOK_SECRET: value('KE2E_STRIPE_WEBHOOK_SECRET'),
    KORTIX_GITHUB_APP_ID: value('KORTIX_GITHUB_APP_ID'),
    KORTIX_GITHUB_APP_PRIVATE_KEY: value('KORTIX_GITHUB_APP_PRIVATE_KEY'),
    KORTIX_GITHUB_APP_SLUG: value('KORTIX_GITHUB_APP_SLUG'),
    MANAGED_GIT_GITHUB_INSTALL_ID: value('MANAGED_GIT_GITHUB_INSTALL_ID'),
    MANAGED_GIT_GITHUB_OWNER: value('MANAGED_GIT_GITHUB_OWNER'),
    OPENROUTER_API_KEY: value('OPENROUTER_API_KEY'),
  };
}

async function writeOutput(name: string, outputValue: string): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `${name}=${outputValue}\n`);
  console.log(`[sandbox-preview] ${name}=${outputValue}`);
}

async function activePreviewPullRequests(
  repository: string,
  token: string,
): Promise<Map<number, string>> {
  const active = new Map<number, string>();
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new Error(`GitHub pull request list returned ${response.status}`);
    const pulls = (await response.json()) as Array<{
      number: number;
      labels?: Array<{ name?: string }>;
      head?: { sha?: string; repo?: { full_name?: string } };
    }>;
    for (const pull of pulls) {
      const approved = pull.labels?.some((label) => label.name === 'preview');
      const sameRepository = pull.head?.repo?.full_name === repository;
      const sha = pull.head?.sha ?? '';
      if (approved && sameRepository && /^[0-9a-f]{40}$/.test(sha)) active.set(pull.number, sha);
    }
    if (pulls.length < 100) return active;
  }
}

const action = process.argv[2] ?? 'deploy';
const repository = value('GITHUB_REPOSITORY', 'kortix-ai/suna');
const platinum = {
  apiUrl: value('PLATINUM_API_URL', 'https://api.platinum.dev'),
  apiKey: value('PLATINUM_API_KEY'),
};
const daytona = {
  apiUrl: value('DAYTONA_API_URL', value('DAYTONA_SERVER_URL', 'https://app.daytona.io/api')),
  apiKey: value('DAYTONA_API_KEY'),
  target: value('DAYTONA_CI_TARGET', value('DAYTONA_TARGET', 'us')),
};

if (action === 'deploy') {
  const prNumber = positiveInteger('PREVIEW_PR_NUMBER');
  const sha = required('PREVIEW_SHA');
  // PREVIEW_BRANCH_ENV turns this deploy into a PERSISTENT per-branch
  // environment: the sandbox is reused instead of replaced, so the URL is
  // stable across pushes (see branchEnvSandboxName).
  const branchEnv = process.env.PREVIEW_BRANCH_ENV?.trim() || undefined;
  // A PR preview is a gate, so it runs the suite. A branch environment is a
  // place to work: the suite is ~10 of the ~14 minutes a deploy takes and
  // proves nothing the stack health check has not, so it is off by default
  // there. PREVIEW_RUN_TESTS=1 forces it back on for a deliberate full run.
  const runTests = process.env.PREVIEW_RUN_TESTS?.trim() === '1' || !branchEnv;
  const deployment: SandboxPreviewDeploymentInput = {
    ...(branchEnv ? { branchEnv } : {}),
    runTests,
    repository,
    ref: value('PREVIEW_REF', sha),
    sha,
    prNumber,
    runId: value('GITHUB_RUN_ID', `local-${Date.now()}`),
    runAttempt: value('GITHUB_RUN_ATTEMPT', '1'),
    root: resolve(value('PREVIEW_ROOT', resolve(import.meta.dir, '../..'))),
    lockfileHash: required('PREVIEW_LOCKFILE_SHA256'),
    secrets: runtimeSecrets(),
    platinum,
    daytona,
  };
  const result = await runSandboxPreview(
    { provider: provider(), prNumber, repository, sha },
    {
      platinum: () => deployPlatinumPreview(deployment),
      daytona: () => deployDaytonaPreview(deployment),
    },
  );
  const staleProviderCleanup = result.provider === 'platinum'
    ? teardownDaytonaPreview({ ...daytona, prNumber })
    : teardownPlatinumPreview({ ...platinum, prNumber });
  await staleProviderCleanup.catch((error) => {
    console.warn(
      `[sandbox-preview] stale provider cleanup failed; scheduled reconciliation will retry: ${String(error)}`,
    );
  });
  await writeOutput('provider', result.provider);
  await writeOutput('sandbox_id', result.sandboxId ?? '');
  await writeOutput('preview_url', result.previewUrl ?? '');
  await writeOutput('report_url', result.previewUrl ? `${result.previewUrl}/_tests/` : '');
  process.exitCode = result.exitCode;
} else if (action === 'teardown') {
  const prNumber = positiveInteger('PREVIEW_PR_NUMBER');
  const [platinumDeleted, daytonaDeleted] = await Promise.all([
    teardownPlatinumPreview({ ...platinum, prNumber }),
    teardownDaytonaPreview({ ...daytona, prNumber }),
  ]);
  console.log(`[sandbox-preview] teardown platinum=${platinumDeleted} daytona=${daytonaDeleted}`);
} else if (action === 'reconcile') {
  const active = await activePreviewPullRequests(repository, required('GITHUB_TOKEN'));
  const [platinumDeleted, daytonaDeleted] = await Promise.all([
    reconcilePlatinumPreviews({ ...platinum, activePullRequests: active }),
    reconcileDaytonaPreviews({ ...daytona, activePullRequests: active }),
  ]);
  console.log(
    `[sandbox-preview] reconcile active=${active.size} platinum_deleted=${platinumDeleted} daytona_deleted=${daytonaDeleted}`,
  );
} else {
  throw new Error(`unknown sandbox preview action: ${action}`);
}
