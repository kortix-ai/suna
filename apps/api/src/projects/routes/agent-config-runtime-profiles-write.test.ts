/**
 * PUT /:projectId/runtime-profiles — the runtime-profiles WRITE route.
 * Multi-harness selection is not feature-gated (2026-07-22, reversing part of
 * `876742672`): any declared harness (opencode/claude/codex/pi) is writable/
 * selectable for every project — there is no `experimental_harnesses` opt-in
 * to check anymore. This file proves that end to end through the real route
 * handler: a body naming any single harness, or all four together, commits
 * cleanly; only shape/reference validation (unknown harness, etc. — covered
 * by `../lib/agent-config-v2.test.ts`'s `applyRuntimeProfilesV3` suite)
 * still rejects a request.
 *
 * IAM (`loadProjectForUser`/`assertProjectCapability`), the trigger-engine's
 * `loadManifestForEdit`, and the real git write path
 * (`withProjectGitAuth`/`commitMultipleFilesToBranch`) are mocked so this
 * file exercises the ACTUAL route handler — not a reimplementation of it —
 * without a live DB or git mirror. Mock BEFORE the dynamic import, mirroring
 * the mock-then-dynamic-import pattern used by
 * `../lib/compile-agent-config.test.ts` and
 * `../session-lifecycle/__tests__/continue-session-deleted-guard.test.ts`.
 * `mock.module` is process-global, so this file must not run in the same
 * process as another file needing the real versions of these modules — the
 * sanctioned `pnpm --filter kortix-api test` runs each file in its own Bun
 * process (`scripts/test.sh`) for exactly this reason.
 */
import { describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

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
        name: 'Runtime Profiles Write Test Project',
        repoUrl: 'https://example.test/runtime-profiles-write-test.git',
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
        metadata: {},
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

describe('PUT /:projectId/runtime-profiles — no harness-selection gate', () => {
  test('a body naming ONLY opencode is accepted and committed', async () => {
    commitCalls = [];
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
    });
    expect(res.status).toBe(200);
    expect(commitCalls).toHaveLength(1);
  });

  test('a body adding a non-opencode harness (claude) alongside opencode is accepted and committed — no opt-in required', async () => {
    commitCalls = [];
    // `kortix`'s existing agent block still references `runtime: opencode`
    // (see the shared `manifestRaw` fixture above), so opencode must stay
    // declared here too — this is agent-reference validation
    // (`applyRuntimeProfilesV3`), unrelated to and unaffected by harness
    // gate removal.
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      claude: { harness: 'claude', config_dir: '.claude' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runtimes.claude).toEqual({ harness: 'claude', config_dir: '.claude' });
    expect(commitCalls).toHaveLength(1);
  });

  test('a body naming all four official harnesses together is accepted and committed', async () => {
    commitCalls = [];
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      claude: { harness: 'claude', config_dir: '.claude' },
      codex: { harness: 'codex', config_dir: '.codex' },
      pi: { harness: 'pi', config_dir: '.pi' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.runtimes).sort()).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(commitCalls).toHaveLength(1);
  });

  test('an unknown harness id is still rejected — shape validation is unaffected by gate removal', async () => {
    commitCalls = [];
    const res = await putRuntimeProfiles({
      opencode: { harness: 'opencode', config_dir: '.kortix/opencode' },
      bogus: { harness: 'not-a-real-harness' },
    });
    expect(res.status).toBe(400);
    expect(commitCalls).toEqual([]);
  });
});
