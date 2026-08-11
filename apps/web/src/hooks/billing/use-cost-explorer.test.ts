import { describe, expect, test } from 'bun:test';

import { buildCostByWorkspaceQuery, buildCostSummaryQuery } from './use-cost-explorer';

const sources = {
  summary: async () => ({ totals: {}, previous: {}, series: [], models: [] }) as never,
  byWorkspace: async () =>
    ({ workspaces: [], total: 0, limit: 25, offset: 0, next_offset: null }) as never,
};

describe('buildCostSummaryQuery', () => {
  test('keys on every scope input so a level switch refetches', () => {
    const query = buildCostSummaryQuery(
      { accountId: 'a', workspaceId: 'p', sessionId: null, from: 'F', to: 'T' },
      sources,
    );
    expect(query.queryKey).toEqual([
      'cost-explorer',
      'summary',
      { accountId: 'a', workspaceId: 'p', sessionId: null, from: 'F', to: 'T' },
    ]);
  });

  test('is disabled until an account id is known', () => {
    const query = buildCostSummaryQuery(
      { accountId: undefined, workspaceId: null, sessionId: null, from: 'F', to: 'T' },
      sources,
    );
    expect(query.enabled).toBe(false);
  });

  test('drills from project scope to session scope by changing only sessionId', () => {
    const workspaceQuery = buildCostSummaryQuery(
      { accountId: 'a', workspaceId: 'p', sessionId: null, from: 'F', to: 'T' },
      sources,
    );
    const sessionQuery = buildCostSummaryQuery(
      { accountId: 'a', workspaceId: 'p', sessionId: 's', from: 'F', to: 'T' },
      sources,
    );
    expect(workspaceQuery.queryKey).not.toEqual(sessionQuery.queryKey);
  });

  test('forwards the exact scope and window to the summary source', async () => {
    const calls: unknown[] = [];
    const query = buildCostSummaryQuery(
      { accountId: 'a', workspaceId: 'p', sessionId: 's', from: 'F', to: 'T' },
      {
        ...sources,
        summary: async (options) => {
          calls.push(options);
          return { totals: {}, previous: {}, series: [], models: [] } as never;
        },
      },
    );
    await query.queryFn();
    expect(calls).toEqual([{ accountId: 'a', workspaceId: 'p', sessionId: 's', from: 'F', to: 'T' }]);
    expect(query.staleTime).toBe(30_000);
  });
});

describe('buildCostByWorkspaceQuery', () => {
  test('keys on window, sort and offset', () => {
    const query = buildCostByWorkspaceQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 25 },
      sources,
    );
    expect(query.queryKey).toEqual([
      'cost-explorer',
      'by-workspace',
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 25 },
    ]);
  });

  test('is disabled until an account id is known', () => {
    const query = buildCostByWorkspaceQuery(
      { accountId: undefined, from: 'F', to: 'T', sort: 'total_desc', offset: 0 },
      sources,
    );
    expect(query.enabled).toBe(false);
  });

  test('a changed window produces a different key than the original window', () => {
    const first = buildCostByWorkspaceQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 0 },
      sources,
    );
    const second = buildCostByWorkspaceQuery(
      { accountId: 'a', from: 'F2', to: 'T2', sort: 'total_desc', offset: 0 },
      sources,
    );
    expect(first.queryKey).not.toEqual(second.queryKey);
  });

  test('a changed sort produces a different key than the original sort', () => {
    const first = buildCostByWorkspaceQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 0 },
      sources,
    );
    const second = buildCostByWorkspaceQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'name_asc', offset: 0 },
      sources,
    );
    expect(first.queryKey).not.toEqual(second.queryKey);
  });

  test('forwards the exact account, window, sort and offset to the by-workspace source', async () => {
    const calls: unknown[] = [];
    const query = buildCostByWorkspaceQuery(
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', offset: 25 },
      {
        ...sources,
        byWorkspace: async (options) => {
          calls.push(options);
          return { workspaces: [], total: 0, limit: 25, offset: 25, next_offset: null } as never;
        },
      },
    );
    await query.queryFn();
    expect(calls).toEqual([
      { accountId: 'a', from: 'F', to: 'T', sort: 'total_desc', limit: 25, offset: 25 },
    ]);
    expect(query.staleTime).toBe(30_000);
  });
});
