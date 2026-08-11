import type { WorkspaceSession } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  buildSessionSearchIndex,
  filterWorkspaceSessions,
  mapWithConcurrency,
  pruneSelection,
  sessionAccessMeta,
  sessionDetailFields,
  sessionOwnerLabel,
  summarizeBulkDelete,
  toggleSelection,
} from './workspace-sessions-helpers';

function makeSession(overrides: Partial<WorkspaceSession> = {}): WorkspaceSession {
  return {
    session_id: 'session-1',
    account_id: 'account-1',
    workspace_id: 'workspace-1',
    branch_name: 'session-1',
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: 'session-1',
    sandbox_url: null,
    opencode_session_id: null,
    name: 'Investigate checkout',
    custom_name: null,
    agent_name: 'kortix',
    status: 'running',
    error: null,
    metadata: {},
    opencode_sessions: [],
    created_at: '2026-07-20T10:00:00.000Z',
    updated_at: '2026-07-20T10:00:00.000Z',
    ...overrides,
  };
}

const FORMATTED = { created: 'Jul 20, 2026, 10:00 AM', updated: 'Jul 21, 2026, 11:00 AM' };

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

describe('sessionDetailFields', () => {
  test('never emits a placeholder formatted like real data', () => {
    const bare = makeSession({
      // Typed non-nullable, but the API returns empty strings before the
      // branch and sandbox exist — which is why the old grid fell back to
      // "Not created" / "Missing" here.
      branch_name: '',
      base_ref: '',
      sandbox_id: '',
      sandbox_provider: null,
      agent_name: null,
      runtime_status: null,
      opencode_session_id: null,
      created_by: null,
      owner_type: undefined,
    });

    const values = sessionDetailFields(bare, FORMATTED).map((field) => field.value);
    for (const placeholder of [
      'Not created',
      'Missing',
      'Unattributed',
      'Not synced',
      'Not provisioned',
      'Default branch',
      'Workspace default',
    ]) {
      expect(values).not.toContain(placeholder);
    }
  });

  test('omits trigger fields for a chat and includes them for a trigger fire', () => {
    const chatLabels = sessionDetailFields(makeSession(), FORMATTED).map((field) => field.label);
    expect(chatLabels).not.toContain('Trigger');
    expect(chatLabels).not.toContain('Source');

    const cron = makeSession({
      metadata: { trigger_source: 'cron', trigger_type: 'cron', trigger_slug: 'nightly-audit' },
    });
    const cronFields = sessionDetailFields(cron, FORMATTED);
    expect(cronFields).toContainEqual({ label: 'Source', value: 'Scheduled', mono: undefined });
    expect(cronFields).toContainEqual({
      label: 'Trigger',
      value: 'nightly-audit',
      mono: undefined,
    });
  });

  test('drops a chat session from 18 fields to a readable handful', () => {
    const fields = sessionDetailFields(
      makeSession({
        branch_name: '',
        base_ref: '',
        sandbox_id: '',
        sandbox_provider: null,
        agent_name: null,
        runtime_status: null,
        opencode_session_id: null,
        created_by: null,
        owner_type: undefined,
      }),
      FORMATTED,
    );
    expect(fields.length).toBeLessThanOrEqual(6);
  });

  test('prints a shared identifier once, not three times', () => {
    // The platform sets sandbox_id == session_id and defaults branch to it.
    const coincident = makeSession({
      session_id: 'df4276b5-28b7',
      sandbox_id: 'df4276b5-28b7',
      branch_name: 'df4276b5-28b7',
    });
    const labels = sessionDetailFields(coincident, FORMATTED).map((f) => f.label);
    expect(labels).toContain('Session ID');
    expect(labels).not.toContain('Branch');
    expect(labels).not.toContain('Sandbox ID');
  });

  test('still shows branch and sandbox when they genuinely differ', () => {
    const distinct = makeSession({
      session_id: 'ses-1',
      sandbox_id: 'sbx-9',
      branch_name: 'kx/nightly-audit',
    });
    const labels = sessionDetailFields(distinct, FORMATTED).map((f) => f.label);
    expect(labels).toContain('Branch');
    expect(labels).toContain('Sandbox ID');
  });

  test('hides "Can open" but surfaces a restricted access state', () => {
    const open = sessionDetailFields(
      makeSession({ can_access: true, runtime_status: 'active' }),
      FORMATTED,
    );
    expect(open.map((field) => field.label)).not.toContain('Your access');

    const restricted = sessionDetailFields(makeSession({ can_access: false }), FORMATTED);
    expect(restricted).toContainEqual({
      label: 'Your access',
      value: 'Metadata only',
      mono: undefined,
    });
  });

  test('counts conversations only when the session has any', () => {
    expect(sessionDetailFields(makeSession(), FORMATTED).map((f) => f.label)).not.toContain(
      'Conversations',
    );

    const withConversations = makeSession({
      opencode_sessions: [
        { id: 'a', parent_id: null, archived_at: null },
        { id: 'b', parent_id: 'a', archived_at: '2026-07-20T10:00:00.000Z' },
      ] as WorkspaceSession['opencode_sessions'],
    });
    expect(sessionDetailFields(withConversations, FORMATTED)).toContainEqual({
      label: 'Conversations',
      value: '2 · 1 archived',
    });
  });
});

describe('selection', () => {
  test('toggles an id on and off without mutating the previous set', () => {
    const initial = new Set<string>();
    const withOne = toggleSelection(initial, 'a');
    expect(withOne.has('a')).toBe(true);
    expect(initial.size).toBe(0);
    expect(toggleSelection(withOne, 'a').has('a')).toBe(false);
  });

  test('prunes ids that scrolled out of the filtered view', () => {
    const selected = new Set(['a', 'b', 'c']);
    const pruned = pruneSelection(selected, [
      makeSession({ session_id: 'a' }),
      makeSession({ session_id: 'c' }),
    ]);
    expect([...pruned].sort()).toEqual(['a', 'c']);
  });

  test('returns the same reference when nothing was pruned, so React skips a render', () => {
    const selected = new Set(['a']);
    expect(pruneSelection(selected, [makeSession({ session_id: 'a' })])).toBe(selected);
  });
});

describe('summarizeBulkDelete', () => {
  test('reports a clean batch', () => {
    expect(
      summarizeBulkDelete([
        { sessionId: 'a', ok: true },
        { sessionId: 'b', ok: true },
      ]).message,
    ).toBe('Deleted 2 sessions');
  });

  test('singularises a batch of one', () => {
    expect(summarizeBulkDelete([{ sessionId: 'a', ok: true }]).message).toBe('Deleted 1 session');
  });

  test('never claims success when part of the batch failed', () => {
    const summary = summarizeBulkDelete([
      { sessionId: 'a', ok: true },
      { sessionId: 'b', ok: false },
      { sessionId: 'c', ok: false },
    ]);
    expect(summary.message).toBe('Deleted 1 of 3. 2 failed.');
    expect(summary.succeeded).toEqual(['a']);
    expect(summary.failed).toEqual(['b', 'c']);
  });

  test('reports a total failure as a failure', () => {
    expect(
      summarizeBulkDelete([
        { sessionId: 'a', ok: false },
        { sessionId: 'b', ok: false },
      ]).message,
    ).toBe('Could not delete 2 sessions');
  });
});

describe('mapWithConcurrency', () => {
  test('preserves input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20, 0], 2, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });
    expect(results).toEqual([30, 10, 20, 0]);
  });

  test('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  test('handles an empty batch', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe('filterWorkspaceSessions', () => {
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
      // Bookkeeping is older, but the conversation itself is newer.
      updated_at: '2026-07-19T10:00:00.000Z',
      opencode_sessions: [
        {
          id: 'oc-newer',
          title: null,
          parent_id: null,
          workspace_id: null,
          created_at: null,
          updated_at: Date.parse('2026-07-21T10:00:00.000Z'),
          archived_at: null,
        },
      ],
    });
    const unrelated = makeSession({ session_id: 'third', name: 'Email report' });

    expect(
      filterWorkspaceSessions([older, unrelated, newer], [], [], 'slack').map((s) => s.session_id),
    ).toEqual(['newer', 'older']);
  });

  test('combines status filters with search', () => {
    const failedDeploy = makeSession({ name: 'Deploy API', status: 'failed' });
    const runningDeploy = makeSession({ name: 'Deploy web', status: 'running' });

    expect(
      filterWorkspaceSessions([failedDeploy, runningDeploy], ['failed'], [], 'deploy'),
    ).toEqual([failedDeploy]);
  });

  // The view passes a memoised index so typing never rebuilds the haystacks.
  // Both paths must agree, or search silently changes behaviour under load.
  test('a prebuilt search index returns the same rows as computing inline', () => {
    const sessions = [
      makeSession({ session_id: 'a', name: 'Slack triage' }),
      makeSession({ session_id: 'b', name: 'Deploy web' }),
      makeSession({ session_id: 'c', name: 'Slack deploy' }),
    ];
    const index = buildSessionSearchIndex(sessions);

    for (const query of ['slack', 'deploy', 'nothing', '']) {
      expect(filterWorkspaceSessions(sessions, [], [], query, index)).toEqual(
        filterWorkspaceSessions(sessions, [], [], query),
      );
    }
  });

  test('a session missing from the index is not silently dropped', () => {
    const known = makeSession({ session_id: 'known', name: 'Slack triage' });
    const late = makeSession({ session_id: 'late', name: 'Slack deploy' });

    // An index built before `late` arrived: it must fall back to computing the
    // haystack rather than treating the row as a non-match.
    const staleIndex = buildSessionSearchIndex([known]);

    expect(
      filterWorkspaceSessions([known, late], [], [], 'slack', staleIndex).map((s) => s.session_id),
    ).toEqual(['known', 'late']);
  });
});

describe('buildSessionSearchIndex', () => {
  test('indexes one lowercased haystack per session id', () => {
    const index = buildSessionSearchIndex([
      makeSession({ session_id: 'a', name: 'Slack Triage' }),
      makeSession({ session_id: 'b', name: 'Deploy Web' }),
    ]);

    expect(index.size).toBe(2);
    expect(index.get('a')).toContain('slack triage');
    expect(index.get('b')).toContain('deploy web');
  });

  test('an empty list indexes nothing', () => {
    expect(buildSessionSearchIndex([]).size).toBe(0);
  });
});
