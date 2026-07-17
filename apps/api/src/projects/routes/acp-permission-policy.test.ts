/**
 * GET/PUT /:projectId/acp/permission-policy — Task WS5-P1-a: the persistent
 * ACP permission-policy API. Additive, metadata-backed
 * (`projects.metadata.acp_permission_policy` — no migration), deny-by-default:
 * an absent policy resolves to `{ autoApprove: 'none', toolDecisions: {} }`,
 * i.e. exactly today's behavior (every tool call prompts, nothing is
 * remembered). This file is the first task of the permission chain — the SDK
 * hook and unified permission surface (P1-b/c) build on this contract.
 *
 * Env note (cycle header, binding): this checkout has no dotenvx keys, so
 * DB-dependent api tests are env-blocked. Mirrors the mock-db idiom of
 * `acp.envelope-persistence.test.ts` / `allocate-runtime-on-open.test.ts` /
 * `agent-config-runtime-profiles-gate.test.ts` — `../lib/access` and
 * `../../shared/db` are fully mocked (mock-module + dynamic-import, BEFORE
 * importing the route module under test) so this file runs env-free under
 * the sanctioned `pnpm --filter kortix-api test` / per-file bun runner.
 *
 * The mandatory regression named in the plan ("not persisted across
 * restart"): a PUT must survive a SEPARATE, later GET — not merely echo back
 * what was just written in the same request. `projectMetadata` below plays
 * the role of the DB row; the mocked `db.update(...).set({ metadata })`
 * mutates it (simulating a real Postgres write), and the mocked
 * `loadProjectForUser` re-reads it fresh on every call — so a stale in-memory
 * cache in the route handler would fail the "fresh GET" assertion below.
 *
 * Deliberately UNLIKE `agent-config-runtime-profiles-gate.test.ts`, this file
 * does NOT `await import('../lib/access')` for a real-module spread before
 * mocking it: `../lib/access` transitively reaches `../../config`, whose
 * top-level `validateEnv()` calls `process.exit(1)` on the encrypted-but-
 * undecrypted `.env` this checkout has (no dotenvx private key — see the
 * cycle header). `acp-permission-policy.ts` (the route under test) imports
 * only `loadProjectForUser`/`assertProjectCapability` from `../lib/access`,
 * so a minimal, non-spread stub is both sufficient and what keeps this file
 * importable at all here — mirroring `acp.envelope-persistence.test.ts`,
 * which stubs `../lib/access` the same non-spread way for the same reason.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

let projectMetadata: Record<string, unknown> = {};
let capabilityDenied = false;
let updateCalls: Array<{ metadata: Record<string, unknown> }> = [];

mock.module('../lib/access', () => ({
  loadProjectForUser: async (_c: unknown, projectId: string) => {
    if (projectId !== PROJECT_ID) return null;
    return {
      userId: 'user-1',
      row: { projectId: PROJECT_ID, accountId: 'acct-1', metadata: projectMetadata },
    };
  },
  assertProjectCapability: async () => {
    if (capabilityDenied) {
      throw new HTTPException(403, { message: 'You do not have permission to customize this project.' });
    }
  },
}));

mock.module('../../shared/db', () => ({
  db: {
    update: (_table: unknown) => ({
      set: (updates: { metadata: Record<string, unknown> }) => ({
        where: async () => {
          updateCalls.push({ metadata: updates.metadata });
          // Simulate a real Postgres write landing in the row a later,
          // independent `loadProjectForUser` call would read back.
          projectMetadata = updates.metadata;
        },
      }),
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./acp-permission-policy');

afterAll(() => {
  // Defense in depth (mirrors acp.envelope-persistence.test.ts): don't leak
  // these stubs into whichever other test file bun's single-process runner
  // loads next.
  mock.restore();
});

function getPolicy(projectId = PROJECT_ID) {
  return projectsApp.request(`/${projectId}/acp/permission-policy`);
}

function putPolicy(body: unknown, projectId = PROJECT_ID) {
  return projectsApp.request(`/${projectId}/acp/permission-policy`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  projectMetadata = {};
  capabilityDenied = false;
  updateCalls = [];
});

describe('GET /:projectId/acp/permission-policy', () => {
  test('returns the conservative default when no policy has ever been stored', async () => {
    const res = await getPolicy();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApprove: 'none', toolDecisions: {} });
  });

  test('returns the stored policy verbatim when present', async () => {
    projectMetadata = {
      acp_permission_policy: { autoApprove: 'reads', toolDecisions: { bash: 'allow', edit_file: 'deny' } },
    };
    const res = await getPolicy();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApprove: 'reads', toolDecisions: { bash: 'allow', edit_file: 'deny' } });
  });

  test('falls back to the conservative default for a malformed stored value, instead of 500ing or trusting it', async () => {
    projectMetadata = { acp_permission_policy: { autoApprove: 'godmode' } };
    const res = await getPolicy();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApprove: 'none', toolDecisions: {} });
  });

  test('404s for a project the caller cannot see', async () => {
    const res = await getPolicy('99999999-2222-4333-8444-555555555555');
    expect(res.status).toBe(404);
  });
});

describe('PUT /:projectId/acp/permission-policy', () => {
  test('PERSISTENCE REGRESSION: round-trips and survives a fresh, independent GET (not a request-scoped echo)', async () => {
    const putRes = await putPolicy({ autoApprove: 'all', toolDecisions: { bash: 'allow', edit_file: 'deny' } });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ autoApprove: 'all', toolDecisions: { bash: 'allow', edit_file: 'deny' } });
    expect(updateCalls).toHaveLength(1);

    const freshGet = await getPolicy();
    expect(freshGet.status).toBe(200);
    expect(await freshGet.json()).toEqual({ autoApprove: 'all', toolDecisions: { bash: 'allow', edit_file: 'deny' } });
  });

  test('an empty body upserts the conservative defaults (autoApprove -> none, toolDecisions -> {})', async () => {
    const res = await putPolicy({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApprove: 'none', toolDecisions: {} });
    expect(updateCalls).toHaveLength(1);
  });

  test('upsert REPLACES the stored policy wholesale rather than deep-merging toolDecisions', async () => {
    projectMetadata = { acp_permission_policy: { autoApprove: 'none', toolDecisions: { bash: 'allow' } } };
    const res = await putPolicy({ autoApprove: 'none', toolDecisions: { edit_file: 'deny' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoApprove: 'none', toolDecisions: { edit_file: 'deny' } });
  });

  test('preserves unrelated metadata keys already on the project', async () => {
    projectMetadata = { onboarding_completed_at: '2026-07-01T00:00:00.000Z' };
    await putPolicy({ autoApprove: 'reads', toolDecisions: {} });
    expect(projectMetadata.onboarding_completed_at).toBe('2026-07-01T00:00:00.000Z');
    expect(projectMetadata.acp_permission_policy).toEqual({ autoApprove: 'reads', toolDecisions: {} });
  });

  test('422s an unknown top-level key and never persists', async () => {
    const res = await putPolicy({ autoApprove: 'none', toolDecisions: {}, extraField: true });
    expect(res.status).toBe(422);
    expect(updateCalls).toEqual([]);
  });

  test('422s an unrecognized autoApprove value and never persists', async () => {
    const res = await putPolicy({ autoApprove: 'everything' });
    expect(res.status).toBe(422);
    expect(updateCalls).toEqual([]);
  });

  test('422s a toolDecisions value outside allow/deny and never persists', async () => {
    const res = await putPolicy({ toolDecisions: { bash: 'maybe' } });
    expect(res.status).toBe(422);
    expect(updateCalls).toEqual([]);
  });

  test('422s an oversize toolDecisions map (metadata-JSONB bloat guard) and never persists', async () => {
    const toolDecisions = Object.fromEntries(
      Array.from({ length: 129 }, (_, index) => [`tool_${index}`, 'allow']),
    );
    const res = await putPolicy({ toolDecisions });
    expect(res.status).toBe(422);
    expect(updateCalls).toEqual([]);
  });

  test('403s a caller who lacks project.customize.write (non-member/insufficient role) and never persists', async () => {
    capabilityDenied = true;
    const res = await putPolicy({ autoApprove: 'reads', toolDecisions: {} });
    expect(res.status).toBe(403);
    expect(updateCalls).toEqual([]);
  });

  test('a denied "all" upsert leaves the existing conservative policy untouched — denial can never widen auto-approval', async () => {
    projectMetadata = { acp_permission_policy: { autoApprove: 'none', toolDecisions: {} } };
    capabilityDenied = true;
    await putPolicy({ autoApprove: 'all', toolDecisions: {} });
    expect(projectMetadata.acp_permission_policy).toEqual({ autoApprove: 'none', toolDecisions: {} });
  });

  test('404s for a project the caller cannot see (checked before the capability gate)', async () => {
    const res = await putPolicy({ autoApprove: 'none', toolDecisions: {} }, '99999999-2222-4333-8444-555555555555');
    expect(res.status).toBe(404);
    expect(updateCalls).toEqual([]);
  });
});
