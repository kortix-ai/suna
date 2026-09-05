#!/usr/bin/env bun
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  type SandboxPreviewProvider,
  branchEnvSandboxName,
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
import { readPreviewRuntimeSecrets } from '../src/core/preview-stack';

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

function optionalPositiveInteger(name: string): number | undefined {
  if (!value(name)) return undefined;
  return positiveInteger(name);
}

/**
 * PREVIEW_SANDBOX_CPU / _RAM_MB / _DISK_GB size the sandbox and the template
 * VMs that prepare it. Unset — the CI shape — means 8 vCPU / 16 GB / 50 GB. A
 * hand deploy onto a smaller Platinum (a dev host) passes what it can hold;
 * any of the three may be given, the others keep the CI value.
 */
function sandboxResources(): { cpu: number; ramMb: number; diskGb: number } | undefined {
  const cpu = optionalPositiveInteger('PREVIEW_SANDBOX_CPU');
  const ramMb = optionalPositiveInteger('PREVIEW_SANDBOX_RAM_MB');
  const diskGb = optionalPositiveInteger('PREVIEW_SANDBOX_DISK_GB');
  if (cpu === undefined && ramMb === undefined && diskGb === undefined) return undefined;
  return { cpu: cpu ?? 8, ramMb: ramMb ?? 16_384, diskGb: diskGb ?? 50 };
}

function provider(): SandboxPreviewProvider {
  const selected = value('PREVIEW_SANDBOX_PROVIDER', 'auto').toLowerCase();
  if (selected === 'auto' || selected === 'platinum' || selected === 'daytona') return selected;
  throw new Error(`PREVIEW_SANDBOX_PROVIDER must be auto, platinum, or daytona; received ${selected}`);
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

/**
 * The slugged sandbox name of every branch that currently exists on the remote.
 *
 * A branch environment is retired by its BRANCH disappearing, not by its pull
 * request closing, so the sweep compares against this rather than against open
 * pull requests. Slugging both sides is what makes the lossy
 * `branchEnvSandboxName` mapping comparable.
 */
async function liveBranchNames(repository: string, token: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (let page = 1; ; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/branches?per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    // Failing OPEN here would make every branch look deleted and the sweep would
    // delete every branch environment at once.
    if (!response.ok) throw new Error(`GitHub branch list returned ${response.status}`);
    const branches = (await response.json()) as Array<{ name?: string }>;
    for (const branch of branches) {
      if (branch.name) names.add(branchEnvSandboxName(branch.name));
    }
    if (branches.length < 100) return names;
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
  // PREVIEW_PUBLIC_ORIGIN is the stable name a proxy serves the environment at.
  // The stack is configured with it; the provider's own hostname stays the
  // proxy's target and comes back as `sandboxOrigin`. It is supplied by the
  // caller, never hardcoded here — a preview origin is provider-issued unless
  // an operator deliberately fronts it.
  const publicOrigin = process.env.PREVIEW_PUBLIC_ORIGIN?.trim() || undefined;
  const resources = sandboxResources();
  // PREVIEW_IMAGE_SHA / PREVIEW_IMAGE_REPO: images built from another commit
  // (identical product code, different tooling) or held in another Docker Hub
  // namespace. Unset — the CI shape — means kortix/*:pr-<PREVIEW_SHA>.
  const imageSha = value('PREVIEW_IMAGE_SHA') || undefined;
  const imageRepo = value('PREVIEW_IMAGE_REPO') || undefined;
  const deployment: SandboxPreviewDeploymentInput = {
    ...(branchEnv ? { branchEnv } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(resources ? { resources } : {}),
    ...(imageSha ? { imageSha } : {}),
    ...(imageRepo ? { imageRepo } : {}),
    runTests,
    repository,
    ref: value('PREVIEW_REF', sha),
    sha,
    prNumber,
    runId: value('GITHUB_RUN_ID', `local-${Date.now()}`),
    runAttempt: value('GITHUB_RUN_ATTEMPT', '1'),
    root: resolve(value('PREVIEW_ROOT', resolve(import.meta.dir, '../..'))),
    lockfileHash: required('PREVIEW_LOCKFILE_SHA256'),
    secrets: readPreviewRuntimeSecrets(process.env),
    // The runner already holds a token good for reading this repo; the sandbox
    // never got one, and GitHub throttles unauthenticated fetches from
    // datacenter ranges by 401-ing the upload-pack POST. Optional by design:
    // absent, the fetch stays anonymous.
    checkoutToken: value('GH_TOKEN') || value('GITHUB_TOKEN'),
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
  // A persistent environment's sandbox is named after the BRANCH, so teardown
  // has to be told which branch or it deletes nothing and the box runs forever.
  // A branch-deleted event carries the branch and no pull request, so the number
  // is optional whenever the branch is known.
  const branchEnv = process.env.PREVIEW_BRANCH_ENV?.trim() || undefined;
  const prNumber = branchEnv && !process.env.PREVIEW_PR_NUMBER?.trim()
    ? undefined
    : positiveInteger('PREVIEW_PR_NUMBER');
  const [platinumDeleted, daytonaDeleted] = await Promise.all([
    teardownPlatinumPreview({
      ...platinum,
      ...(prNumber === undefined ? {} : { prNumber }),
      ...(branchEnv ? { branchEnv } : {}),
    }),
    prNumber === undefined ? Promise.resolve(0) : teardownDaytonaPreview({ ...daytona, prNumber }),
  ]);
  console.log(`[sandbox-preview] teardown platinum=${platinumDeleted} daytona=${daytonaDeleted}`);
} else if (action === 'reconcile') {
  const token = required('GITHUB_TOKEN');
  const active = await activePreviewPullRequests(repository, token);
  // A branch environment is retired by its BRANCH disappearing, not by its pull
  // request closing, so the sweep needs to know which branches still exist.
  const liveBranchSandboxNames = await liveBranchNames(repository, token);
  const [platinumDeleted, daytonaDeleted] = await Promise.all([
    reconcilePlatinumPreviews({ ...platinum, activePullRequests: active, liveBranchSandboxNames }),
    reconcileDaytonaPreviews({ ...daytona, activePullRequests: active }),
  ]);
  console.log(
    `[sandbox-preview] reconcile active=${active.size} platinum_deleted=${platinumDeleted} daytona_deleted=${daytonaDeleted}`,
  );
} else {
  throw new Error(`unknown sandbox preview action: ${action}`);
}
