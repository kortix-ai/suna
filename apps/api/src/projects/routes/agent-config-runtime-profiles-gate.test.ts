/**
 * PUT /:projectId/runtime-profiles — the runtime-profiles WRITE route
 * (Task WS2-P1-b). Claude/Codex/Pi are selectable ONLY once a project opts
 * into `experimental_harnesses` (founder posture: OpenCode is the only
 * non-experimental harness). This gate is on SELECTION/WRITE only — an
 * already-declared v3 manifest (the shipped base template declares all four
 * runtimes) keeps reading and compiling regardless of the flag; see
 * `starter-template-fleet.test.ts` and `compile-runtime-config.test.ts`,
 * both untouched by this task.
 *
 * IAM (`loadProjectForUser`/`assertProjectCapability`), the trigger-engine's
 * `loadManifestForEdit`, and the real git write path
 * (`withProjectGitAuth`/`commitMultipleFilesToBranch`) are mocked so this
 * file exercises the ACTUAL route handler's gate wiring — not a
 * reimplementation of it — without a live DB or git mirror. Mock BEFORE the
 * dynamic import, mirroring the mock-then-dynamic-import pattern used by
 * `../lib/compile-agent-config.test.ts` and
 * `../session-lifecycle/__tests__/continue-session-deleted-guard.test.ts`.
 * `mock.module` is process-global, so this file must not run in the same
 * process as another file needing the real versions of these modules — the
 * sanctioned `pnpm --filter kortix-api test` runs each file in its own Bun
 * process (`scripts/test.sh`) for exactly this reason.
 */
import { describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

let projectMetadata: Record<string, unknown> = {};
let manifestRaw: Record<string, unknown> = {
  kortix_version: 3,
  default_agent: 'kortix',
  runtimes: {
    opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
  },
  agents: {
    kortix: {
      runtime: 'opencode',
      connectors: 'all',
      secrets: 'all',
      skills: 'all',
      kortix_cli: 'none',
    },
  },
};
let commitCalls: Array<{ files?: Array<{ path: string; content: string }>; message: string }> = [];

// Spread the REAL module in every mock below — `mock.module()` is a
// process-wide registry (see disk-quota-guard.test.ts / compile-agent-config
// .test.ts), so an incomplete stub here would drop named exports OTHER
// modules in this same process still statically import (e.g. `../triggers`
// imports `commitFileToBranch` from `../git`, which re-exports from
// `./git/branches`) and crash them at link time instead of at this file's
// own call sites.
const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, projectId: string) => {
    if (projectId !== PROJECT_ID) return null;
    return {
      userId: 'user-1',
      row: {
        projectId: PROJECT_ID,
        accountId: 'acct-1',
        name: 'Gate Test Project',
        repoUrl: 'https://example.test/gate-test.git',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        metadata: projectMetadata,
      },
    };
  },
  assertProjectCapability: async () => {},
}));

const realTriggersLib = await import('../lib/triggers');
mock.module('../lib/triggers', () => ({
  ...realTriggersLib,
  loadManifestForEdit: async () => ({
    schemaVersion: 3,
    raw: manifestRaw,
    format: 'yaml',
    path: 'kortix.yaml',
  }),
}));

const realGitLib = await import('../lib/git');
mock.module('../lib/git', () => ({
  ...realGitLib,
  withProjectGitAuth: async (project: unknown) => ({ ...(project as object), gitAuthToken: null }),
}));

const realGitBranches = await import('../git/branches');
mock.module('../git/branches', () => ({
  ...realGitBranches,
  commitMultipleFilesToBranch: async (_project: unknown, opts: { files?: Array<{ path: string; content: string }>; message: string }) => {
    commitCalls.push(opts);
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./agent-config');

function putRuntimeProfiles(runtimes: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/runtime-profiles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimes }),
  });
}

describe('PUT /:projectId/runtime-profiles — experimental_harnesses gate', () => {
  test('flag OFF: a body naming an experimental harness (claude) is rejected 422, never committed', async () => {
    projectMetadata = {};
    commitCalls = [];
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      claude: { harness: 'claude', config_dir: '.claude' },
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('experimental_harness_disabled');
    expect(String(body.error)).toContain('claude');
    expect(commitCalls).toEqual([]);
  });

  test('flag OFF: a body naming ONLY opencode (the stable harness) is never gated', async () => {
    projectMetadata = {};
    commitCalls = [];
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
    });
    expect(res.status).toBe(200);
    expect(commitCalls).toHaveLength(1);
  });

  test('flag ON: the same experimental-harness body is accepted and committed', async () => {
    projectMetadata = { experimental: { experimental_harnesses: true } };
    commitCalls = [];
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      claude: { harness: 'claude', config_dir: '.claude' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimes.claude).toEqual({ harness: 'claude', config_dir: '.claude' });
    expect(commitCalls).toHaveLength(1);
  });
});
