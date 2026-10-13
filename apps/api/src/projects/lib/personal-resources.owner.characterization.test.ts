/**
 * Characterization pins for `resolveSessionPersonalOwner` (KRTX-1499).
 *
 * No test reached the session-side resolver itself: every consumer mocks it,
 * and only the pure `personalResourceOwner` decision was pinned. The KRTX-1499
 * flatten rewrites the resolver's branching, so these pins capture today's
 * answers across the matrix the issue names — strict vs flag-gated ×
 * governed/ungoverned grant × a live token vs a cleared token vs the mint
 * fallback. The drizzle reads run against a mocked `../../shared/db` keyed by
 * table, the same idiom as `project-git-write.characterization.test.ts`; the
 * mint rule (`resolveSessionOnBehalfOf`) runs for real on top of those rows.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { accountMemberships, accountTokens, projectSessions } from '@kortix/db';

type Row = Record<string, unknown>;

const HUMAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LAUNCHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SESSION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AGENT_SA = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const GOVERNED_GRANT = { agent: 'support-agent', permissions: 'all', connectors: 'all' };
const META_GRANT = { agent: 'meta', permissions: 'all', connectors: 'all' };

let rows: Partial<Record<'projectSessions' | 'accountTokens' | 'accountMemberships', Row[]>> = {};
let failReads = false;

function seed(tables: typeof rows): void {
  rows = tables;
}

function rowFor(table: unknown): Row[] {
  if (failReads) throw new Error('synthetic db failure');
  if (table === projectSessions) return rows.projectSessions ?? [];
  if (table === accountTokens) return rows.accountTokens ?? [];
  if (table === accountMemberships) return rows.accountMemberships ?? [];
  return [];
}

mock.module('../../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => rowFor(table),
        }),
      }),
    }),
  },
}));

const { resolveSessionPersonalOwner } = await import('./personal-resources');
const { ON_BEHALF_OF_CLEARED_KEY } = await import('./on-behalf-of');

function sessionRow(overrides: Row = {}): Row {
  return {
    accountId: ACCOUNT,
    visibility: 'private',
    createdBy: LAUNCHER,
    origin: 'api',
    metadata: {},
    ...overrides,
  };
}

function tokenRow(overrides: Row = {}): Row {
  return {
    agentGrant: GOVERNED_GRANT,
    onBehalfOfUserId: HUMAN,
    status: 'active',
    serviceAccountId: AGENT_SA,
    revokedAt: null,
    ...overrides,
  };
}

const BASE = { projectId: PROJECT, sessionId: SESSION, legacyUserId: LAUNCHER, accountId: ACCOUNT };

beforeEach(() => {
  failReads = false;
  seed({ projectSessions: [sessionRow()] });
});

describe('resolveSessionPersonalOwner — strict (secret audiences)', () => {
  test('a governed token with on_behalf_of in a private session resolves that human', async () => {
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow()] });
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBe(HUMAN);
  });

  test('a shared session resolves none even under strict', async () => {
    seed({ projectSessions: [sessionRow({ visibility: 'project' })], accountTokens: [tokenRow()] });
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBeNull();
  });

  test('a cleared token falls through to the mint rule, which answers null', async () => {
    seed({
      projectSessions: [sessionRow({ metadata: { [ON_BEHALF_OF_CLEARED_KEY]: '2026-10-01T00:00:00Z' } })],
      accountTokens: [tokenRow({ onBehalfOfUserId: null })],
    });
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBeNull();
  });

  test('strict skips the ungoverned legacy branch: the token value answers', async () => {
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow({ agentGrant: null })] });
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBe(HUMAN);
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow({ agentGrant: META_GRANT })] });
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBe(HUMAN);
  });

  test('a cleared token on an unattended origin mints null', async () => {
    seed({
      projectSessions: [sessionRow({ origin: 'trigger', metadata: { [ON_BEHALF_OF_CLEARED_KEY]: 'x' } })],
      accountTokens: [tokenRow({ onBehalfOfUserId: null })],
      accountMemberships: [{ userId: LAUNCHER, accountId: ACCOUNT }],
    });
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBeNull();
  });
});

describe('resolveSessionPersonalOwner — flag-gated (strict unset)', () => {
  test('a governed token with on_behalf_of in a private session resolves that human', async () => {
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow()] });
    expect(await resolveSessionPersonalOwner(BASE)).toBe(HUMAN);
  });

  test('an ungoverned grant keeps the legacy user', async () => {
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow({ agentGrant: null })] });
    expect(await resolveSessionPersonalOwner(BASE)).toBe(LAUNCHER);
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow({ agentGrant: META_GRANT })] });
    expect(await resolveSessionPersonalOwner(BASE)).toBe(LAUNCHER);
  });

  test('a governed token with on_behalf_of cleared (no mint stamp) resolves none', async () => {
    seed({ projectSessions: [sessionRow()], accountTokens: [tokenRow({ onBehalfOfUserId: null })] });
    expect(await resolveSessionPersonalOwner(BASE)).toBeNull();
  });

  test('no token: the mint rule answers for a member-launched session', async () => {
    seed({
      projectSessions: [sessionRow()],
      accountTokens: [],
      accountMemberships: [{ userId: LAUNCHER, accountId: ACCOUNT }],
    });
    expect(await resolveSessionPersonalOwner(BASE)).toBe(LAUNCHER);
    expect(await resolveSessionPersonalOwner({ ...BASE, strict: true })).toBe(LAUNCHER);
  });

  test('no token and an unattended origin: none', async () => {
    seed({
      projectSessions: [sessionRow({ origin: 'trigger' })],
      accountTokens: [],
      accountMemberships: [{ userId: LAUNCHER, accountId: ACCOUNT }],
    });
    expect(await resolveSessionPersonalOwner(BASE)).toBeNull();
  });

  test('no token and a non-member launcher: none', async () => {
    seed({ projectSessions: [sessionRow()], accountTokens: [], accountMemberships: [] });
    expect(await resolveSessionPersonalOwner(BASE)).toBeNull();
  });

  test('a pending visibility resolves against the given visibility, not the stored one', async () => {
    seed({ projectSessions: [sessionRow({ visibility: 'private' })], accountTokens: [tokenRow()] });
    expect(
      await resolveSessionPersonalOwner({ ...BASE, visibility: 'project' }),
    ).toBeNull();
  });
});

describe('resolveSessionPersonalOwner — degenerate inputs', () => {
  test('no session id: the legacy user, or null under strict', async () => {
    expect(await resolveSessionPersonalOwner({ ...BASE, sessionId: null })).toBe(LAUNCHER);
    expect(await resolveSessionPersonalOwner({ ...BASE, sessionId: null, strict: true })).toBeNull();
  });

  test('a failed read resolves null, never the legacy user', async () => {
    failReads = true;
    expect(await resolveSessionPersonalOwner(BASE)).toBeNull();
  });

  test('a session row that vanished resolves null', async () => {
    seed({ projectSessions: [], accountTokens: [tokenRow()] });
    expect(await resolveSessionPersonalOwner(BASE)).toBeNull();
  });
});
