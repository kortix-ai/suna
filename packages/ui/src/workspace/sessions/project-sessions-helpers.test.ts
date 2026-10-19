import type { ProjectSession } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';
import { createTranslator } from 'next-intl';

import deMessages from '../../../../../apps/web/translations/de.json';
import { testUiTranslator } from '../../test-utils/intl';
import {
  bulkDeleteConfirmLabel,
  cachedSessionsScope,
  filterProjectSessions,
  mapWithConcurrency,
  pruneSelection,
  sessionAccessMeta,
  sessionDetailFields,
  sessionOwnerLabel,
  summarizeBulkDelete,
  toggleSelection,
} from './project-sessions-helpers';

// A second, non-English catalog: these helpers must render their labels
// through the keys the caller's locale resolves, not through hardcoded
// English. Asserting the German copy pins both the key lookup and the routing
// of the translator — an English translator cannot tell a hardcoded literal
// from a catalog hit, because both read the same.
const deUiTranslator = createTranslator({
  locale: 'de',
  messages: deMessages,
  namespace: 'hardcodedUi.i18nComplete',
});

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
        testUiTranslator,
      ),
    ).toBe('Ari');
    expect(
      sessionOwnerLabel(
        makeSession({ owner_type: 'service_account', owner_name: 'backend-debugger' }),
        testUiTranslator,
      ),
    ).toBe('backend-debugger');
    expect(
      sessionOwnerLabel(
        makeSession({ is_owner: false, created_by: 'owner-id', owner_email: null }),
        testUiTranslator,
      ),
    ).toBe('Unknown owner');
  });

  test('resolves "You" and "Unknown owner" through the catalog, in the caller\'s locale', () => {
    expect(sessionOwnerLabel(makeSession({ is_owner: true }), deUiTranslator)).toBe('Du');
    expect(
      sessionOwnerLabel(
        makeSession({ is_owner: false, created_by: 'owner-id', owner_email: null }),
        deUiTranslator,
      ),
    ).toBe('Unbekannter Eigentümer');
  });

  test('distinguishes permission from a missing or archived runtime', () => {
    expect(sessionAccessMeta(makeSession({ can_access: false }), testUiTranslator)).toMatchObject({
      label: 'Metadata only',
      canOpen: false,
    });
    expect(
      sessionAccessMeta(
        makeSession({ can_access: true, runtime_status: 'archived' }),
        testUiTranslator,
      ),
    ).toMatchObject({ label: 'Runtime unavailable', canOpen: false });
    expect(
      sessionAccessMeta(
        makeSession({ can_access: true, status: 'stopped', runtime_status: null }),
        testUiTranslator,
      ),
    ).toMatchObject({ label: 'Runtime unavailable', canOpen: false });
    expect(
      sessionAccessMeta(
        makeSession({ can_access: true, runtime_status: 'active' }),
        testUiTranslator,
      ),
    ).toMatchObject({ label: 'Can open', canOpen: true });
  });
});

describe('sessionDetailFields', () => {
  test('labels Source, Trigger, Last activity, Created and Owner through the catalog, in the caller\'s locale', () => {
    const cron = makeSession({
      is_owner: true,
      metadata: { trigger_source: 'cron', trigger_type: 'cron', trigger_slug: 'nightly-audit' },
    });
    const fields = sessionDetailFields(cron, FORMATTED, deUiTranslator);
    const labels = fields.map((field) => field.label);

    expect(labels).toContain('Quelle');
    expect(labels).toContain('Trigger');
    expect(labels).toContain('Letzte Aktivität');
    expect(labels).toContain('Erstellt');
    expect(labels).toContain('Eigentümer');
    expect(labels).not.toContain('Source');
    expect(labels).not.toContain('Last activity');
    expect(labels).not.toContain('Created');
    expect(labels).not.toContain('Owner');
    // The Owner field's VALUE routes through the same translator.
    expect(fields.find((field) => field.label === 'Eigentümer')?.value).toBe('Du');
  });

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

    const values = sessionDetailFields(bare, FORMATTED, testUiTranslator).map(
      (field) => field.value,
    );
    for (const placeholder of [
      'Not created',
      'Missing',
      'Unattributed',
      'Not synced',
      'Not provisioned',
      'Default branch',
      'Project default',
    ]) {
      expect(values).not.toContain(placeholder);
    }
  });

  test('omits trigger fields for a chat and includes them for a trigger fire', () => {
    const chatLabels = sessionDetailFields(makeSession(), FORMATTED, testUiTranslator).map(
      (field) => field.label,
    );
    expect(chatLabels).not.toContain('Trigger');
    expect(chatLabels).not.toContain('Source');

    const cron = makeSession({
      metadata: { trigger_source: 'cron', trigger_type: 'cron', trigger_slug: 'nightly-audit' },
    });
    const cronFields = sessionDetailFields(cron, FORMATTED, testUiTranslator);
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
      testUiTranslator,
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
    const labels = sessionDetailFields(coincident, FORMATTED, testUiTranslator).map((f) => f.label);
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
    const labels = sessionDetailFields(distinct, FORMATTED, testUiTranslator).map((f) => f.label);
    expect(labels).toContain('Branch');
    expect(labels).toContain('Sandbox ID');
  });

  test('hides "Can open" but surfaces a restricted access state', () => {
    const open = sessionDetailFields(
      makeSession({ can_access: true, runtime_status: 'active' }),
      FORMATTED,
      testUiTranslator,
    );
    expect(open.map((field) => field.label)).not.toContain('Your access');

    const restricted = sessionDetailFields(
      makeSession({ can_access: false }),
      FORMATTED,
      testUiTranslator,
    );
    expect(restricted).toContainEqual({
      label: 'Your access',
      value: 'Metadata only',
      mono: undefined,
    });
  });

  test('counts conversations only when the session has any', () => {
    expect(
      sessionDetailFields(makeSession(), FORMATTED, testUiTranslator).map((f) => f.label),
    ).not.toContain('Conversations');

    const withConversations = makeSession({
      opencode_sessions: [
        { id: 'a', parent_id: null, archived_at: null },
        { id: 'b', parent_id: 'a', archived_at: '2026-07-20T10:00:00.000Z' },
      ] as ProjectSession['opencode_sessions'],
    });
    expect(sessionDetailFields(withConversations, FORMATTED, testUiTranslator)).toContainEqual({
      label: 'Conversations',
      value: '2 · 1 archived',
    });
  });
});

describe('bulkDeleteConfirmLabel', () => {
  test('reads the Delete {value0} message through the translator, in the caller\'s locale', () => {
    expect(bulkDeleteConfirmLabel(5, testUiTranslator)).toBe('Delete 5');
    expect(bulkDeleteConfirmLabel(5, deUiTranslator)).toBe('5 löschen');
    expect(bulkDeleteConfirmLabel(1, deUiTranslator)).toBe('1 löschen');
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
      summarizeBulkDelete(
        [
          { sessionId: 'a', ok: true },
          { sessionId: 'b', ok: true },
        ],
        testUiTranslator,
      ).message,
    ).toBe('Deleted 2 sessions');
  });

  test('singularises a batch of one', () => {
    expect(summarizeBulkDelete([{ sessionId: 'a', ok: true }], testUiTranslator).message).toBe(
      'Deleted 1 session',
    );
  });

  test('never claims success when part of the batch failed', () => {
    const summary = summarizeBulkDelete(
      [
        { sessionId: 'a', ok: true },
        { sessionId: 'b', ok: false },
        { sessionId: 'c', ok: false },
      ],
      testUiTranslator,
    );
    expect(summary.message).toBe('Deleted 1 of 3. 2 failed.');
    expect(summary.succeeded).toEqual(['a']);
    expect(summary.failed).toEqual(['b', 'c']);
  });

  test('reports a total failure as a failure', () => {
    expect(
      summarizeBulkDelete(
        [
          { sessionId: 'a', ok: false },
          { sessionId: 'b', ok: false },
        ],
        testUiTranslator,
      ).message,
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

describe('filterProjectSessions', () => {
  test('sorts by latest activity, not bookkeeping time', () => {
    const older = makeSession({ session_id: 'older', updated_at: '2026-07-20T10:00:00.000Z' });
    const newer = makeSession({
      session_id: 'newer',
      // Bookkeeping is older, but the conversation itself is newer.
      updated_at: '2026-07-19T10:00:00.000Z',
      opencode_sessions: [
        {
          id: 'oc-newer',
          title: null,
          parent_id: null,
          project_id: null,
          created_at: null,
          updated_at: Date.parse('2026-07-21T10:00:00.000Z'),
          archived_at: null,
        },
      ],
    });

    expect(
      filterProjectSessions([older, newer], [], [], testUiTranslator).map((s) => s.session_id),
    ).toEqual(['newer', 'older']);
  });

  test('applies status and source facets', () => {
    const failedSlack = makeSession({ status: 'failed', metadata: { source: 'slack' } });
    const runningSlack = makeSession({ session_id: 's2', status: 'running', metadata: { source: 'slack' } });
    const failedEmail = makeSession({ session_id: 's3', status: 'failed', metadata: { source: 'email' } });

    expect(
      filterProjectSessions([failedSlack, runningSlack, failedEmail], ['failed'], ['slack'], testUiTranslator),
    ).toEqual([failedSlack]);
  });
});

describe('filterProjectSessions — owner and access facets', () => {
  const alice = makeSession({ session_id: 'alice', created_by: 'u-alice', visibility: 'project' });
  const bob = makeSession({ session_id: 'bob', created_by: 'u-bob', visibility: 'private' });
  const bob2 = makeSession({ session_id: 'bob-2', created_by: 'u-bob', visibility: 'restricted' });

  const ids = (sessions: ProjectSession[]) => sessions.map((s) => s.session_id).sort();

  test('owner and access filters AND with each other and with the other facets', () => {
    const all = [alice, bob, bob2];
    expect(ids(filterProjectSessions(all, [], [], testUiTranslator, { owners: ['u-bob'] }))).toEqual(['bob', 'bob-2']);
    expect(ids(filterProjectSessions(all, [], [], testUiTranslator, { access: ['private'] }))).toEqual(['bob']);
    expect(
      ids(filterProjectSessions(all, [], [], testUiTranslator, { owners: ['u-bob'], access: ['project'] })),
    ).toEqual([]);
  });

  test('omitting the owner and access facets keeps the old behaviour', () => {
    expect(ids(filterProjectSessions([alice, bob, bob2], [], [], testUiTranslator))).toEqual(['alice', 'bob', 'bob-2']);
  });
});

describe('cachedSessionsScope — the list a reload shows before the manager probe answers', () => {
  const ROOT = { parent: 'root' } as const;
  const page = (id: string) => ({ pages: [{ items: [{ session_id: id }], next_cursor: null }], pageParams: [null] });
  const write = (
    client: QueryClient,
    scope: 'project' | 'visible',
    filters: Parameters<typeof qk.project.sessionsPaged>[2],
    updatedAt: number,
  ) => client.setQueryData(qk.project.sessionsPaged('p-1', scope, filters), page(scope), { updatedAt });

  test('nothing restored: no scope, the page waits for the probe as before', () => {
    expect(cachedSessionsScope(new QueryClient(), 'p-1', ROOT)).toBeNull();
  });

  test("a manager's restored inventory: the 'project' scope", () => {
    const client = new QueryClient();
    write(client, 'project', ROOT, 1_000);
    expect(cachedSessionsScope(client, 'p-1', ROOT)).toBe('project');
  });

  test("a member's restored list: the 'visible' scope", () => {
    const client = new QueryClient();
    write(client, 'visible', ROOT, 1_000);
    expect(cachedSessionsScope(client, 'p-1', ROOT)).toBe('visible');
  });

  test('both restored: the newer read, which carries the latest access this user had', () => {
    const client = new QueryClient();
    write(client, 'project', ROOT, 1_000);
    write(client, 'visible', ROOT, 2_000);
    expect(cachedSessionsScope(client, 'p-1', ROOT)).toBe('visible');
    write(client, 'project', ROOT, 3_000);
    expect(cachedSessionsScope(client, 'p-1', ROOT)).toBe('project');
  });

  test('only the entry of the filters on screen counts', () => {
    const client = new QueryClient();
    // The sidebar's own list, and this page under another tab.
    write(client, 'visible', { parent: 'root', startedBy: 'me' }, 1_000);
    write(client, 'project', { parent: 'root', startedBy: 'automated' }, 1_000);
    expect(cachedSessionsScope(client, 'p-1', ROOT)).toBeNull();
    expect(cachedSessionsScope(client, 'p-1', { parent: 'root', startedBy: 'automated' })).toBe('project');
    expect(cachedSessionsScope(client, 'p-2', { parent: 'root', startedBy: 'automated' })).toBeNull();
  });

  test('a query that never answered holds no rows to show', () => {
    const client = new QueryClient();
    client.getQueryCache().build(client, { queryKey: qk.project.sessionsPaged('p-1', 'project', ROOT) });
    expect(cachedSessionsScope(client, 'p-1', ROOT)).toBeNull();
  });
});
