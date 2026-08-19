import { describe, expect, test } from 'bun:test';

import {
  buildSessionCostDetailQuery,
  buildSessionCostProjectsQuery,
  buildSessionCostsListQuery,
  resetSessionCostProjectFilter,
  type SessionCostQuerySources,
} from './use-session-costs';

const sources = {
  list: async () => ({ source: 'list' }),
  get: async () => ({ source: 'detail' }),
  projects: async () => [{ project_id: 'project-1', name: 'Project One' }],
} as unknown as SessionCostQuerySources;

describe('session cost query builders', () => {
  test('uses an account- and filter-scoped list key and exact SDK options', async () => {
    const calls: unknown[] = [];
    const query = buildSessionCostsListQuery(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        limit: 25,
        offset: 0,
      },
      {
        ...sources,
        list: async (options) => {
          calls.push(options);
          return { source: 'list' } as never;
        },
      },
    );

    expect(query.queryKey).toEqual([
      'session-costs',
      'list',
      {
        accountId: 'account-1',
        projectId: 'project-1',
        limit: 25,
        offset: 0,
      },
    ]);
    await query.queryFn();
    expect(calls).toEqual([
      {
        accountId: 'account-1',
        projectId: 'project-1',
        limit: 25,
        offset: 0,
      },
    ]);
    expect(query.staleTime).toBe(30_000);
  });

  test('keys and forwards the window, sort and owner filter so changing them refetches', async () => {
    const calls: unknown[] = [];
    const query = buildSessionCostsListQuery(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        limit: 25,
        offset: 0,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        sort: 'total_desc',
        ownerId: 'owner-1',
      },
      {
        ...sources,
        list: async (options) => {
          calls.push(options);
          return { source: 'list' } as never;
        },
      },
    );

    expect(query.queryKey).toEqual([
      'session-costs',
      'list',
      {
        accountId: 'account-1',
        projectId: 'project-1',
        limit: 25,
        offset: 0,
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        sort: 'total_desc',
        ownerId: 'owner-1',
      },
    ]);
    await query.queryFn();
    expect(calls).toEqual([
      {
        accountId: 'account-1',
        projectId: 'project-1',
        ownerId: 'owner-1',
        sort: 'total_desc',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        limit: 25,
        offset: 0,
      },
    ]);

    const changedWindow = buildSessionCostsListQuery(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        limit: 25,
        offset: 0,
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-07-01T00:00:00.000Z',
        sort: 'total_desc',
        ownerId: 'owner-1',
      },
      sources,
    );
    expect(changedWindow.queryKey).not.toEqual(query.queryKey);
  });

  test('list query is disabled until an account id is known', () => {
    const disabled = buildSessionCostsListQuery(
      { accountId: undefined, projectId: null, limit: 25, offset: 0 },
      sources,
    );
    const enabled = buildSessionCostsListQuery(
      { accountId: 'account-1', projectId: null, limit: 25, offset: 0 },
      sources,
    );
    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
  });

  test('enables detail only for a selected session and binds its project', async () => {
    const calls: unknown[] = [];
    const disabled = buildSessionCostDetailQuery(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        sessionId: null,
      },
      sources,
    );
    const enabled = buildSessionCostDetailQuery(
      {
        accountId: 'account-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
      {
        ...sources,
        get: async (sessionId, options) => {
          calls.push({ sessionId, options });
          return { source: 'detail' } as never;
        },
      },
    );

    expect(disabled.enabled).toBe(false);
    expect(enabled.enabled).toBe(true);
    expect(enabled.queryKey).toEqual([
      'session-costs',
      'detail',
      {
        accountId: 'account-1',
        projectId: 'project-1',
        sessionId: 'session-1',
      },
    ]);
    await enabled.queryFn();
    expect(calls).toEqual([
      {
        sessionId: 'session-1',
        options: { accountId: 'account-1', projectId: 'project-1' },
      },
    ]);
  });

  test('detail query stays disabled without an account id even when a session is selected', () => {
    const query = buildSessionCostDetailQuery(
      { accountId: undefined, projectId: 'project-1', sessionId: 'session-1' },
      sources,
    );
    expect(query.enabled).toBe(false);
  });

  test('scopes the project catalog and resets pagination when the filter changes', async () => {
    const calls: unknown[] = [];
    const query = buildSessionCostProjectsQuery('account-1', {
      ...sources,
      projects: async (accountId) => {
        calls.push(accountId);
        return [];
      },
    });

    expect(query.queryKey).toEqual(['session-costs', 'projects', 'account-1']);
    await query.queryFn();
    expect(calls).toEqual(['account-1']);
    expect(resetSessionCostProjectFilter({ projectId: null, offset: 50 }, 'project-1')).toEqual({
      projectId: 'project-1',
      offset: 0,
    });
  });
});
