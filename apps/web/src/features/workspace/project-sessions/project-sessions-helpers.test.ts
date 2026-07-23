import type { ProjectSession } from '@kortix/sdk/projects-client';
import { describe, expect, test } from 'bun:test';

import {
  filterProjectSessions,
  matchesProjectSessionsFilter,
  projectSessionsFilterCounts,
  sessionAccessMeta,
  sessionOwnerLabel,
} from './project-sessions-helpers';

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    session_id: 'session-1',
    account_id: 'account-1',
    project_id: 'project-1',
    branch_name: 'session-1',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: 'session-1',
    sandbox_url: null,
    runtime_session_id: null,
    name: 'Investigate checkout',
    custom_name: null,
    agent_name: 'kortix',
    status: 'running',
    error: null,
    metadata: {},
    runtime_sessions: [],
    created_at: '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('matchesProjectSessionsFilter', () => {
  test('groups every provisioning state with running sessions as active', () => {
    for (const status of ['queued', 'branching', 'provisioning', 'running'] as const) {
      expect(matchesProjectSessionsFilter(makeSession({ status }), 'active')).toBe(true);
    }
    expect(matchesProjectSessionsFilter(makeSession({ status: 'completed' }), 'active')).toBe(
      false,
    );
  });

  test('detects automation and viewer-relative shared sessions', () => {
    const automated = makeSession({ metadata: { trigger_source: 'cron' } });
    const shared = makeSession({ is_owner: false });

    expect(matchesProjectSessionsFilter(automated, 'automated')).toBe(true);
    expect(matchesProjectSessionsFilter(shared, 'shared')).toBe(true);
    expect(matchesProjectSessionsFilter(makeSession(), 'shared')).toBe(false);
  });

  test('separates deleted and inaccessible sessions for inventory debugging', () => {
    expect(
      matchesProjectSessionsFilter(
        makeSession({ deleted_at: '2026-07-20T10:00:00.000Z' }),
        'deleted',
      ),
    ).toBe(true);
    expect(matchesProjectSessionsFilter(makeSession({ can_access: false }), 'inaccessible')).toBe(
      true,
    );
  });
});

describe('session inventory identity and access labels', () => {
  test('labels human and agent owners without pretending an unknown owner is the viewer', () => {
    expect(
      sessionOwnerLabel(
        makeSession({ owner_type: 'user', owner_name: 'Ari', owner_email: 'ari@kortix.ai' }),
      ),
    ).toBe('Ari');
    expect(
      sessionOwnerLabel(
        makeSession({ owner_type: 'service_account', owner_name: 'backend-debugger' }),
      ),
    ).toBe('backend-debugger');
    expect(
      sessionOwnerLabel(
        makeSession({ is_owner: false, created_by: 'owner-id', owner_email: null }),
      ),
    ).toBe('Unknown owner');
  });

  test('distinguishes permission from a missing or archived runtime', () => {
    expect(sessionAccessMeta(makeSession({ can_access: false }))).toMatchObject({
      label: 'Metadata only',
      canOpen: false,
    });
    expect(
      sessionAccessMeta(makeSession({ can_access: true, runtime_status: 'archived' })),
    ).toMatchObject({ label: 'Runtime unavailable', canOpen: false });
    expect(
      sessionAccessMeta(makeSession({ can_access: true, status: 'stopped', runtime_status: null })),
    ).toMatchObject({ label: 'Runtime unavailable', canOpen: false });
    expect(
      sessionAccessMeta(makeSession({ can_access: true, runtime_status: 'active' })),
    ).toMatchObject({ label: 'Can open', canOpen: true });
  });
});

describe('filterProjectSessions', () => {
  test('searches visible session fields and sorts by latest activity', () => {
    const older = makeSession({
      session_id: 'older',
      name: 'Slack triage',
      metadata: { source: 'slack' },
      updated_at: '2026-07-20T10:00:00.000Z',
    });
    const newer = makeSession({
      session_id: 'newer',
      name: 'Slack deploy',
      metadata: { source: 'slack' },
      updated_at: '2026-07-21T10:00:00.000Z',
    });
    const unrelated = makeSession({ session_id: 'third', name: 'Email report' });

    expect(
      filterProjectSessions([older, unrelated, newer], 'all', 'slack').map((s) => s.session_id),
    ).toEqual(['newer', 'older']);
  });

  test('combines status filters with search', () => {
    const failedDeploy = makeSession({ name: 'Deploy API', status: 'failed' });
    const runningDeploy = makeSession({ name: 'Deploy web', status: 'running' });

    expect(filterProjectSessions([failedDeploy, runningDeploy], 'failed', 'deploy')).toEqual([
      failedDeploy,
    ]);
  });
});

describe('projectSessionsFilterCounts', () => {
  test('reports counts for every filter', () => {
    const counts = projectSessionsFilterCounts([
      makeSession({ status: 'running' }),
      makeSession({ session_id: 'two', status: 'failed', is_owner: false, can_access: false }),
      makeSession({
        session_id: 'three',
        status: 'completed',
        metadata: { trigger_source: 'cron' },
      }),
    ]);

    expect(counts).toMatchObject({
      all: 3,
      active: 1,
      completed: 1,
      stopped: 0,
      failed: 1,
      automated: 1,
      shared: 1,
      deleted: 0,
      inaccessible: 1,
    });
  });
});
