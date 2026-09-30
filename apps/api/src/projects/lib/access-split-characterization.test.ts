import { describe, expect, mock, test } from 'bun:test';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import * as realShare from '../../connectors/share';
import type { SecretGrant, ShareSubject } from '../../connectors/share';
import * as realAuthorize from '../../iam/authorize';
import * as realReadModels from '../../iam/read-models';

/**
 * Characterization tests for the access.ts split (KRTX-301). They pin the
 * behavior the split must preserve, through the `./access` import path the
 * split keeps as its public surface, so they pass unchanged before and after
 * the move.
 *
 * The existing access.test.ts covers the pure predicates (manager standing,
 * bypass eligibility, identity caching) but no actual visibility decision and
 * no capability denial. Pinned here:
 *
 *   1. a USER visibility decision — a private session is visible to its owner
 *      through `loadVisibleSession`, with manager standing stripped;
 *   2. a USER visibility denial — the same private session is invisible to
 *      everyone else, even before account oversight is consulted;
 *   3. a GROUP visibility decision — a restricted session opens for a member
 *      through a GROUP grant (not ownership, not a member grant), and the
 *      grant alone buys no standing;
 *   4. a CAPABILITY denial — `loadProjectForUser` throws the project 403 for
 *      a member whose IAM verdict denies, with account membership present.
 *
 * The db mock is the FIFO chain the suite uses elsewhere (see
 * unit-slack-access-request.test.ts). The share module is spread REAL with
 * only the two subject/grant SOURCES stubbed, so every pinned decision runs
 * through the real `isProjectSessionVisibleTo` ladder.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '55555555-5555-4555-8555-555555555555';
const SESSION_ID = '66666666-6666-4666-8666-666666666666';

// ─── db mock: FIFO of query results ──────────────────────────────────────────
let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'values', 'returning', 'onConflictDoNothing', 'onConflictDoUpdate', 'set']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain() },
  hasDatabase: () => true,
}));

// ─── share mock: real ladder, stubbed sources ────────────────────────────────
let shareSubject: ShareSubject = { userId: USER_ID, groupIds: [] };
let sessionGrants = new Map<string, SecretGrant[]>();
mock.module('../../connectors/share', () => ({
  ...realShare,
  resolveShareSubject: async (userId: string) => ({ ...shareSubject, userId }),
  loadSessionGrants: async (sessionIds: string[]) => {
    const out = new Map<string, SecretGrant[]>();
    for (const id of sessionIds) out.set(id, sessionGrants.get(id) ?? []);
    return out;
  },
}));

// ─── iam mock: membership/role labels and a controllable engine verdict ──────
mock.module('../../iam/read-models', () => ({
  ...realReadModels,
  accountRoleFor: async () => 'member',
  projectRoleForUser: async () => 'member',
}));
mock.module('../../iam/authorize', () => ({
  ...realAuthorize,
  authorize: async () => ({ allowed: false, reason: 'role_missing' }),
}));

const { loadProjectForUser, loadVisibleSession } = await import('./access');

/** A project row as `loadProjectForUser`'s own select returns it. */
const projectRow = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, status: 'active' };

/** A session row as `loadProjectSessionRow`'s select returns it. */
const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  sessionId: SESSION_ID,
  projectId: PROJECT_ID,
  accountId: ACCOUNT_ID,
  createdBy: OWNER_ID,
  visibility: 'private',
  metadata: {},
  initiatorType: null,
  origin: null,
  ...overrides,
});

/** The `loaded` shape routes hand to loadVisibleSession (hand-built, as the
 *  signature's own doc allows: the members.manage probe then declines). */
const loaded = (overrides: Record<string, unknown> = {}) => ({
  row: projectRow,
  userId: USER_ID,
  effectiveRole: 'member',
  actor: null,
  ...overrides,
});

describe('access split characterization — visibility decisions', () => {
  test('a private session is visible to its owner (user decision)', async () => {
    dbResults = [[sessionRow({ createdBy: USER_ID })]];
    shareSubject = { userId: USER_ID, groupIds: [] };
    sessionGrants = new Map();

    const result = await loadVisibleSession(loaded(), SESSION_ID, null, null);

    expect(result).not.toBeNull();
    expect(result?.isOwner).toBe(true);
    // Owner-only visibility buys no manager standing.
    expect(result?.canManageProject).toBe(false);
    expect(result?.canManageLifecycle).toBe(true);
    expect(result?.canManageSharing).toBe(true);
    expect(result?.ownerIsMachine).toBe(false);
  });

  test('the same private session is invisible to everyone else (user denial)', async () => {
    dbResults = [[sessionRow({ createdBy: OWNER_ID })]];
    shareSubject = { userId: USER_ID, groupIds: [] };
    sessionGrants = new Map();

    const result = await loadVisibleSession(loaded(), SESSION_ID, null, null);

    expect(result).toBeNull();
  });

  test('a restricted session opens through a GROUP grant (group decision)', async () => {
    dbResults = [[sessionRow({ createdBy: OWNER_ID, visibility: 'restricted' })]];
    shareSubject = { userId: USER_ID, groupIds: ['group-sales'] };
    sessionGrants = new Map([
      [SESSION_ID, [{ principalType: 'group', principalId: 'group-sales' } as SecretGrant]],
    ]);

    const result = await loadVisibleSession(loaded(), SESSION_ID, null, null);

    // Not the owner, not a member grant — the group grant is the whole reason.
    expect(result).not.toBeNull();
    expect(result?.isOwner).toBe(false);
    expect(result?.canManageProject).toBe(false);
    expect(result?.canManageLifecycle).toBe(false);
    expect(result?.canManageSharing).toBe(false);
    expect(result?.ownerIsMachine).toBe(false);
  });
});

describe('access split characterization — capability denial', () => {
  test('a member whose IAM verdict denies gets the project 403', async () => {
    dbResults = [[projectRow]];
    const c = {
      get: (k: string) =>
        k === 'userId'
          ? USER_ID
          : k === 'authType'
            ? 'pat'
            : k === 'actor'
              ? { userId: USER_ID, accountId: ACCOUNT_ID, credential: { kind: 'pat' }, ctx: {} }
              : undefined,
      set: () => {},
      req: { header: () => undefined },
    } as unknown as Context;

    let caught: unknown = null;
    try {
      await loadProjectForUser(c, PROJECT_ID, 'read');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HTTPException);
    const denial = caught as HTTPException;
    expect(denial.status).toBe(403);
    expect(await denial.res.json()).toEqual({
      error: true,
      message: 'You do not have access to this project',
      status: 403,
      code: 'role_missing',
      action: 'project.read',
    });
  });
});
