import { describe, expect, test } from 'bun:test';
import type { projectSessions } from '@kortix/db';

import {
  mergeSessionOwnerIdentities,
  selectSessionRowsForViewer,
} from './session-inventory';

const VIEWER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function row(
  sessionId: string,
  overrides: Partial<typeof projectSessions.$inferSelect> = {},
): typeof projectSessions.$inferSelect {
  return {
    sessionId,
    accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    branchName: sessionId,
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: sessionId,
    sandboxUrl: null,
    opencodeSessionId: null,
    agentName: 'default',
    subproject: null,
    status: 'running',
    error: null,
    createdBy: VIEWER_ID,
    visibility: 'private',
    origin: 'user',
    originRef: null,
    secretsAllowlist: null,
    requiredConnectors: null,
    connectorBindingsInheritUnbound: false,
    connectorBindingsConfigured: false,
    metadata: {},
    createdAt: new Date('2026-07-21T00:00:00.000Z'),
    updatedAt: new Date('2026-07-21T00:00:00.000Z'),
    ...overrides,
  };
}

const subject = { userId: VIEWER_ID, groupIds: [] };

describe('selectSessionRowsForViewer', () => {
  test('manager project scope hides inaccessible rows and keeps accessible unavailable and soft-deleted rows', () => {
    const privateOther = row('private-other', { createdBy: OTHER_ID });
    const stoppedWithoutRuntime = row('stopped-lost', { status: 'stopped' });
    const deleted = row('deleted', {
      status: 'stopped',
      metadata: {
        deletedAt: '2026-07-20T10:00:00.000Z',
        deletedBy: VIEWER_ID,
      },
    });

    const selected = selectSessionRowsForViewer({
      rows: [privateOther, stoppedWithoutRuntime, deleted],
      scope: 'project',
      canManageProject: true,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map(),
    });

    expect(selected.authorized).toBe(true);
    expect(selected.items.map((item) => item.row.sessionId)).toEqual([
      'stopped-lost',
      'deleted',
    ]);
    expect(selected.items[0]).toMatchObject({
      canAccess: true,
      runtimeStatus: null,
    });
    expect(selected.items[1]).toMatchObject({
      canAccess: true,
      deletedAt: '2026-07-20T10:00:00.000Z',
      deletedBy: VIEWER_ID,
    });
  });

  test('project scope is denied without project-management rights', () => {
    const selected = selectSessionRowsForViewer({
      rows: [row('private-other', { createdBy: OTHER_ID })],
      scope: 'project',
      canManageProject: false,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map(),
    });

    expect(selected).toEqual({ authorized: false, items: [] });
  });

  test('manager inventory includes trigger-created private rows and hides ordinary private rows', () => {
    const selected = selectSessionRowsForViewer({
      rows: [
        row('trigger-private', {
          createdBy: OTHER_ID,
          metadata: {
            source: 'trigger:scheduler',
            trigger_kind: 'git',
            trigger_slug: 'daily-review',
          },
        }),
        row('human-private', { createdBy: OTHER_ID, metadata: {} }),
      ],
      scope: 'project',
      canManageProject: true,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map(),
    });

    expect(selected.items.map(({ row: item, canAccess }) => [item.sessionId, canAccess])).toEqual([
      ['trigger-private', true],
    ]);
  });

  test('ordinary members still cannot access trigger-created private rows', () => {
    const selected = selectSessionRowsForViewer({
      rows: [row('trigger-private', {
        createdBy: OTHER_ID,
        metadata: {
          source: 'trigger:scheduler',
          trigger_kind: 'git',
          trigger_slug: 'daily-review',
        },
      })],
      scope: 'visible',
      canManageProject: false,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map(),
    });

    expect(selected.items).toEqual([]);
  });

  test('visible scope preserves the existing visibility and resumability filters', () => {
    const own = row('own');
    const privateOther = row('private-other', { createdBy: OTHER_ID });
    const stoppedLost = row('stopped-lost', { status: 'stopped' });
    const stoppedResumable = row('stopped-resumable', { status: 'stopped' });
    const deleted = row('deleted', {
      metadata: { deletedAt: '2026-07-20T10:00:00.000Z' },
    });

    const selected = selectSessionRowsForViewer({
      rows: [own, privateOther, stoppedLost, stoppedResumable, deleted],
      scope: 'visible',
      canManageProject: false,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map([['stopped-resumable', 'stopped']]),
    });

    expect(selected.authorized).toBe(true);
    expect(selected.items.map((item) => item.row.sessionId)).toEqual([
      'own',
      'stopped-resumable',
    ]);
  });
});

/**
 * The project shell pre-creates a warm session on mount so the sandbox is
 * already up when the user finishes typing. Until its first prompt lands it
 * holds no user work, so the sidebar must not show a session the user never
 * started. ONE marker carries that — see projects/lib/warm-sessions.ts.
 */
describe('selectSessionRowsForViewer — warm sessions', () => {
  function visible(rows: Array<typeof projectSessions.$inferSelect>) {
    return selectSessionRowsForViewer({
      rows,
      scope: 'visible',
      canManageProject: false,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map(),
    }).items.map((item) => item.row.sessionId);
  }

  test('visible scope hides a warm session', () => {
    expect(visible([row('own'), row('warm', { metadata: { warm: true } })])).toEqual(['own']);
  });

  test('a used session lists like any other — the first prompt drops the marker', () => {
    expect(visible([row('used-warm', { metadata: {} })])).toEqual(['used-warm']);
  });

  // The reaper flips `project_sessions.status` to stopped and leaves the marker
  // in place. That row must not surface through the resumable-stopped branch.
  test('a reaped warm session stays hidden even though it looks resumable', () => {
    const selected = selectSessionRowsForViewer({
      rows: [row('reaped-warm', { status: 'stopped', metadata: { warm: true } })],
      scope: 'visible',
      canManageProject: false,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map([['reaped-warm', 'stopped']]),
    });

    expect(selected.items).toEqual([]);
  });

  // A manager auditing the project must see every session, warm ones included:
  // they are real rows holding a real sandbox.
  test('project scope keeps the warm session', () => {
    const selected = selectSessionRowsForViewer({
      rows: [row('own'), row('warm', { metadata: { warm: true } })],
      scope: 'project',
      canManageProject: true,
      subject,
      grantsBySession: new Map(),
      callerSessionId: null,
      boundCredentialSessionId: null,
      runtimeStatusBySession: new Map(),
    });

    expect(selected.items.map((item) => item.row.sessionId)).toEqual(['own', 'warm']);
  });

  test('a malformed warm marker never hides a real session', () => {
    const rows = [
      row('no-metadata', { metadata: null }),
      row('empty', { metadata: {} }),
      row('string-marker', { metadata: { warm: 'true' } }),
      row('array-marker', { metadata: { warm: [true] } }),
      row('object-marker', { metadata: { warm: { state: 'available' } } }),
      row('legacy-marker', { metadata: { warm_session: { state: 'available' } } }),
    ];
    expect(visible(rows)).toEqual([
      'no-metadata',
      'empty',
      'string-marker',
      'array-marker',
      'object-marker',
      'legacy-marker',
    ]);
  });
});

describe('mergeSessionOwnerIdentities', () => {
  test('resolves humans, agent service accounts, and stale principals distinctly', () => {
    const humanId = '33333333-3333-4333-8333-333333333333';
    const agentId = '44444444-4444-4444-8444-444444444444';
    const staleId = '55555555-5555-4555-8555-555555555555';

    const identities = mergeSessionOwnerIdentities({
      ownerIds: [humanId, agentId, staleId],
      users: new Map([
        [humanId, { exists: true, email: 'ari@kortix.ai', displayName: 'Ari' }],
        [agentId, { exists: false, email: null, displayName: null }],
        [staleId, { exists: false, email: null, displayName: null }],
      ]),
      serviceAccounts: [
        {
          serviceAccountId: agentId,
          name: 'Agent backend-debugger',
          agentName: 'backend-debugger',
        },
      ],
    });

    expect(identities.get(humanId)).toEqual({
      type: 'user',
      name: 'Ari',
      email: 'ari@kortix.ai',
    });
    expect(identities.get(agentId)).toEqual({
      type: 'service_account',
      name: 'backend-debugger',
      email: null,
    });
    expect(identities.get(staleId)).toEqual({
      type: 'unknown',
      name: null,
      email: null,
    });
  });
});

describe('backend credential session isolation', () => {
  const WRAPPER = '33333333-3333-4333-8333-333333333333';
  const wrapperSubject = { userId: WRAPPER, groupIds: [] };

  const alice = row('aaaa1111-1111-4111-8111-111111111111', {
    createdBy: WRAPPER,
    origin: 'backend',
    originRef: null,
  });
  const bob = row('bbbb2222-2222-4222-8222-222222222222', {
    createdBy: WRAPPER,
    origin: 'backend',
    originRef: null,
  });

  const select = (callerSessionId: string | null) =>
    selectSessionRowsForViewer({
      rows: [alice, bob],
      scope: 'visible',
      canManageProject: false,
      subject: wrapperSubject,
      grantsBySession: new Map(),
      callerSessionId,
      boundCredentialSessionId: callerSessionId,
      runtimeStatusBySession: new Map(),
    });

  test("alice's sandbox cannot see bob's session", () => {
    const accessible = select(alice.sessionId)
      .items.filter((item) => item.canAccess)
      .map((item) => item.row.sessionId);
    expect(accessible).toEqual([alice.sessionId]);
  });

  test("bob's sandbox cannot see alice's session", () => {
    const accessible = select(bob.sessionId)
      .items.filter((item) => item.canAccess)
      .map((item) => item.row.sessionId);
    expect(accessible).toEqual([bob.sessionId]);
  });

  test('the wrapper backend itself still sees BOTH — it is the operator', () => {
    // Not session-bound: this is the wrapper's own credential acting for nobody
    // in particular, so created_by ownership is legitimate here.
    const accessible = select(null)
      .items.filter((item) => item.canAccess)
      .map((item) => item.row.sessionId);
    expect(accessible).toEqual([alice.sessionId, bob.sessionId]);
  });

  test('an INTERACTIVE session is unaffected by the caller binding', () => {
    // created_by really is one person there, so narrowing would break
    // `kortix sessions ls` from inside a normal sandbox.
    const mine = row('cccc3333-3333-4333-8333-333333333333', { createdBy: VIEWER_ID });
    const sibling = row('dddd4444-4444-4444-8444-444444444444', { createdBy: VIEWER_ID });
    const selected = selectSessionRowsForViewer({
      rows: [mine, sibling],
      scope: 'visible',
      canManageProject: false,
      subject,
      grantsBySession: new Map(),
      callerSessionId: mine.sessionId,
      boundCredentialSessionId: mine.sessionId,
      runtimeStatusBySession: new Map(),
    });
    expect(selected.items.every((item) => item.canAccess)).toBe(true);
  });
});

/**
 * The runtime-status lookup used to be filtered by `inArray(sessionId, rows)`
 * on top of an (accountId, projectId) predicate that already scopes it to this
 * project. Dropping the redundant filter is what lets that query run
 * CONCURRENTLY with the sessions read instead of after it
 * (projects/lib/session-list.ts). It is only safe because the map is consumed
 * strictly by per-row lookup — pin that.
 */
describe('runtime status map tolerates a superset', () => {
  test('an entry for a session that is not in the list changes nothing', () => {
    const kept = row('kept', { status: 'running' });

    const withExact = selectSessionRowsForViewer({
      rows: [kept],
      scope: 'visible',
      canManageProject: false,
      subject,
      callerSessionId: null,
      boundCredentialSessionId: null,
      grantsBySession: new Map(),
      runtimeStatusBySession: new Map([['kept', 'active' as const]]),
    });

    const withSuperset = selectSessionRowsForViewer({
      rows: [kept],
      scope: 'visible',
      canManageProject: false,
      subject,
      callerSessionId: null,
      boundCredentialSessionId: null,
      grantsBySession: new Map(),
      runtimeStatusBySession: new Map([
        ['kept', 'active' as const],
        // A sandbox row for a session this viewer never sees (another owner's
        // private session, or one soft-deleted out of the listing).
        ['not-in-this-list', 'stopped' as const],
        ['also-not-here', 'error' as const],
      ]),
    });

    expect(withSuperset.items.map((item) => item.row.sessionId)).toEqual(
      withExact.items.map((item) => item.row.sessionId),
    );
    expect(withSuperset.items.map((item) => item.runtimeStatus)).toEqual(
      withExact.items.map((item) => item.runtimeStatus),
    );
  });

  test('a row with no runtime entry still reports null, not a neighbour status', () => {
    const orphan = row('orphan', { status: 'running' });

    const selected = selectSessionRowsForViewer({
      rows: [orphan],
      scope: 'visible',
      canManageProject: false,
      subject,
      callerSessionId: null,
      boundCredentialSessionId: null,
      grantsBySession: new Map(),
      runtimeStatusBySession: new Map([['someone-else', 'active' as const]]),
    });

    expect(selected.items).toHaveLength(1);
    expect(selected.items[0]!.runtimeStatus).toBeNull();
  });
});

/**
 * Subprojects are IAM objects, closed by default. A session inside one is not
 * "hidden but listed" — it is not a row at all for a viewer without the grant,
 * in BOTH scopes, including for a project manager who was scoped out. The
 * opposite direction is `sessions: shared`, where the subproject grant IS the
 * read right for every session in it. See lib/subproject-access.ts.
 */
describe('selectSessionRowsForViewer — subprojects', () => {
  const base = {
    scope: 'visible' as const,
    canManageProject: false,
    subject,
    grantsBySession: new Map(),
    callerSessionId: null,
    boundCredentialSessionId: null,
    runtimeStatusBySession: new Map(),
  };

  const plain = row('plain');
  const mine = row('mine-in-marketing', { subproject: 'marketing' });
  const theirs = row('theirs-in-marketing', { createdBy: OTHER_ID, subproject: 'marketing' });
  const research = row('in-research', { subproject: 'research' });

  test('a row in an ungranted subproject is dropped, plain rows survive', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [plain, mine, research],
      accessibleSubprojects: new Set(['marketing']),
    });
    expect(selected.items.map((item) => item.row.sessionId)).toEqual(['plain', 'mine-in-marketing']);
  });

  test('the drop applies to the manager `project` scope too', () => {
    // Both rows are project-visible, so the ONLY thing separating them is the
    // subproject grant — a manager scoped out of `research` loses that row.
    const openMarketing = row('open-marketing', {
      createdBy: OTHER_ID,
      visibility: 'project',
      subproject: 'marketing',
    });
    const openResearch = row('open-research', {
      createdBy: OTHER_ID,
      visibility: 'project',
      subproject: 'research',
    });
    const selected = selectSessionRowsForViewer({
      ...base,
      scope: 'project',
      canManageProject: true,
      rows: [plain, openMarketing, openResearch],
      accessibleSubprojects: new Set(['marketing']),
    });
    expect(selected.items.map((item) => item.row.sessionId)).toEqual([
      'plain',
      'open-marketing',
    ]);
  });

  test('omitting the accessible set drops every subproject row — fail closed', () => {
    const selected = selectSessionRowsForViewer({ ...base, rows: [plain, mine, research] });
    expect(selected.items.map((item) => item.row.sessionId)).toEqual(['plain']);
  });

  test('`sessions: private` keeps another owner’s session unreadable', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [theirs],
      accessibleSubprojects: new Set(['marketing']),
    });
    // Listed as a row for the grantee, but not accessible — the ordinary
    // per-session model is untouched, so the `visible` scope filters it out.
    expect(selected.items).toEqual([]);
  });

  test('`sessions: shared` opens every session in the subproject to a grantee', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [theirs],
      accessibleSubprojects: new Set(['marketing']),
      sharedSubprojects: new Set(['marketing']),
    });
    expect(selected.items.map((item) => [item.row.sessionId, item.canAccess])).toEqual([
      ['theirs-in-marketing', true],
    ]);
  });

  test('`sessions: shared` never widens a subproject the viewer was not granted', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [theirs],
      accessibleSubprojects: new Set(),
      sharedSubprojects: new Set(['marketing']),
    });
    expect(selected.items).toEqual([]);
  });

  test('?subproject=<slug> narrows to one subproject', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [plain, mine, research],
      accessibleSubprojects: new Set(['marketing', 'research']),
      subprojectFilter: 'research',
    });
    expect(selected.items.map((item) => item.row.sessionId)).toEqual(['in-research']);
  });

  test('?subproject= (empty) narrows to the sessions in none', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [plain, mine, research],
      accessibleSubprojects: new Set(['marketing', 'research']),
      subprojectFilter: '',
    });
    expect(selected.items.map((item) => item.row.sessionId)).toEqual(['plain']);
  });

  test('no filter parameter lists every accessible row', () => {
    const selected = selectSessionRowsForViewer({
      ...base,
      rows: [plain, mine, research],
      accessibleSubprojects: new Set(['marketing', 'research']),
    });
    expect(selected.items.map((item) => item.row.sessionId)).toEqual([
      'plain',
      'mine-in-marketing',
      'in-research',
    ]);
  });
});
