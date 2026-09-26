import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { qk } from '@kortix/sdk/react';

import { reviewKeys } from '@/features/review-center/hooks/use-review-items';

import {
  CUSTOMIZE_PREFETCH_GC_MS,
  type CustomizePrefetchApi,
  type CustomizePrefetchGates,
  prefetchCustomize,
} from './use-customize-prefetch';

const PROJECT = 'p-1';

const ALL: CustomizePrefetchGates = {
  customizeRead: true,
  customizeWrite: true,
  connectorRead: true,
  triggerRead: true,
  secretRead: true,
  reviewRead: true,
  membersManage: true,
  llmGateway: true,
  discoverEnabled: false,
};

function fakeApi(calls: string[]): CustomizePrefetchApi {
  const read =
    (name: string) =>
    async (..._args: unknown[]) => {
      calls.push(name);
      return { name } as never;
    };
  return {
    getProject: read('getProject'),
    getConnectStatus: (async () => {
      calls.push('getConnectStatus');
      return { configured: true, provider: 'composio', providers: ['composio'] };
    }) as never,
    getModelDefaults: read('getModelDefaults'),
    getProjectModelPicker: read('getProjectModelPicker'),
    listConnectors: read('listConnectors'),
    listProjectBranches: read('listProjectBranches'),
    listProjectResourceGrants: read('listProjectResourceGrants'),
    listProjectSandboxTemplates: read('listProjectSandboxTemplates'),
    listProjectSecrets: read('listProjectSecrets'),
    listProjectSnapshots: read('listProjectSnapshots'),
    listProjectTriggers: read('listProjectTriggers'),
    listReviewItems: read('listReviewItems'),
    loadCatalogQueries: async () => ({
      connectStatusQuery: { queryKey: ['connect-status', 'composio-first-v2'] as const },
      catalogSectionsQuery: (projectId: string, catalogue: string | null) => ({
        queryKey: ['catalog-sections', projectId, catalogue] as const,
        queryFn: async () => {
          calls.push(`sections:${catalogue}`);
          return { sections: [] } as never;
        },
        staleTime: 5 * 60_000,
      }),
    }) as never,
  };
}

describe('prefetchCustomize', () => {
  test('fills the exact entries each Customize tab reads', async () => {
    const client = new QueryClient();
    const calls: string[] = [];

    await prefetchCustomize(client, PROJECT, ALL, fakeApi(calls));

    const filled = [
      qk.project.summary(PROJECT),
      qk.project.triggers(PROJECT),
      qk.project.connectors(PROJECT),
      qk.project.secrets(PROJECT),
      reviewKeys.list(PROJECT),
      qk.project.resourceGrants(PROJECT),
      qk.project.modelPicker(PROJECT),
      ['model-defaults', PROJECT],
      qk.project.sandboxTemplates(PROJECT),
      qk.project.snapshots(PROJECT),
      qk.project.branches(PROJECT),
      ['connect-status', 'composio-first-v2'],
      ['catalog-sections', PROJECT, 'composio'],
    ];
    for (const key of filled) {
      expect({ key, data: client.getQueryData(key) !== undefined }).toEqual({ key, data: true });
    }
    expect(calls).toContain('sections:composio');
  });

  test('keeps prefetched entries for half an hour without an observer', async () => {
    const client = new QueryClient();
    await prefetchCustomize(client, PROJECT, ALL, fakeApi([]));

    const entry = client.getQueryCache().find({ queryKey: qk.project.triggers(PROJECT) });

    expect(entry?.gcTime).toBe(CUSTOMIZE_PREFETCH_GC_MS);
  });

  test('reads nothing without project.customize.read', async () => {
    const client = new QueryClient();
    const calls: string[] = [];

    await prefetchCustomize(client, PROJECT, { ...ALL, customizeRead: false }, fakeApi(calls));

    expect(calls).toEqual([]);
  });

  test('skips every read the caller may not make', async () => {
    const client = new QueryClient();
    const calls: string[] = [];

    await prefetchCustomize(
      client,
      PROJECT,
      {
        ...ALL,
        customizeWrite: false,
        connectorRead: false,
        secretRead: false,
        reviewRead: false,
        membersManage: false,
        llmGateway: false,
      },
      fakeApi(calls),
    );

    expect(calls.sort()).toEqual(['getProject', 'listProjectTriggers']);
  });

  test('never refetches an entry that is still fresh', async () => {
    const client = new QueryClient();
    const first: string[] = [];
    const second: string[] = [];

    await prefetchCustomize(client, PROJECT, ALL, fakeApi(first));
    await prefetchCustomize(client, PROJECT, ALL, fakeApi(second));

    expect(first.length).toBeGreaterThan(0);
    // Review's 5 s freshness is the only one a back-to-back pass can outlive.
    expect(second.filter((name) => name !== 'listReviewItems')).toEqual([]);
  });

  test('uses the Discover catalogue when the project flag selects it', async () => {
    const client = new QueryClient();
    const calls: string[] = [];

    await prefetchCustomize(client, PROJECT, { ...ALL, discoverEnabled: true }, fakeApi(calls));

    expect(calls).toContain('sections:discover');
    expect(calls).not.toContain('getConnectStatus');
  });
});
