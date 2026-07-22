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
    status: 'running',
    error: null,
    createdBy: VIEWER_ID,
    visibility: 'private',
    origin: 'user',
    originRef: null,
    metadata: {},
    createdAt: new Date('2026-07-21T00:00:00.000Z'),
    updatedAt: new Date('2026-07-21T00:00:00.000Z'),
    ...overrides,
  };
}

const subject = { userId: VIEWER_ID, groupIds: [] };

describe('selectSessionRowsForViewer', () => {
  test('manager project scope includes inaccessible, unavailable, and soft-deleted rows', () => {
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
      runtimeStatusBySession: new Map(),
    });

    expect(selected.authorized).toBe(true);
    expect(selected.items.map((item) => item.row.sessionId)).toEqual([
      'private-other',
      'stopped-lost',
      'deleted',
    ]);
    expect(selected.items[0]).toMatchObject({
      canAccess: false,
      runtimeStatus: null,
    });
    expect(selected.items[1]).toMatchObject({
      canAccess: true,
      runtimeStatus: null,
    });
    expect(selected.items[2]).toMatchObject({
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
      runtimeStatusBySession: new Map(),
    });

    expect(selected).toEqual({ authorized: false, items: [] });
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
      runtimeStatusBySession: new Map([['stopped-resumable', 'stopped']]),
    });

    expect(selected.authorized).toBe(true);
    expect(selected.items.map((item) => item.row.sessionId)).toEqual([
      'own',
      'stopped-resumable',
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
