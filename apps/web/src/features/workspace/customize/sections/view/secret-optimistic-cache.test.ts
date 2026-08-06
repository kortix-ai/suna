import { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'bun:test';

import type { ProjectSecret, ProjectSecretsResponse } from '@kortix/sdk';
import {
  applyProjectSecretResponse,
  beginOptimisticProjectSecretSave,
  rollbackOptimisticProjectSecretSave,
  type OptimisticProjectSecretInput,
} from './secret-optimistic-cache';

const QUERY_KEY = ['project-secrets', 'p1'];

function secret(overrides: Partial<ProjectSecret> = {}): ProjectSecret {
  return {
    identifier: 'EXAMPLE_TOKEN',
    name: 'EXAMPLE_TOKEN',
    project_id: 'p1',
    secret_id: 'secret-1',
    created_by: 'user-1',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    configured: true,
    mine: null,
    effective_source: 'shared',
    can_manage_shared: true,
    strategy: 'runtime',
    consumer: 'sandbox',
    delivery_status: 'available',
    egress_policy: null,
    requires_rotation: false,
    ...overrides,
  };
}

function response(items: ProjectSecret[]): ProjectSecretsResponse {
  return {
    items,
    required: ['REQUIRED_TOKEN'],
    optional: ['OPTIONAL_TOKEN'],
    can_manage: true,
    manifest_status: 'loaded',
    manifest_path: 'kortix.yaml',
  };
}

function input(
  overrides: Partial<OptimisticProjectSecretInput> = {},
): OptimisticProjectSecretInput {
  return {
    projectId: 'p1',
    identifier: 'NEW_TOKEN',
    name: 'NEW_TOKEN',
    strategy: 'broker',
    consumer: 'http_broker',
    deliveryStatus: 'available',
    egressPolicy: {
      rules: [{ host: 'httpbingo.org', methods: ['GET'], path: '/headers' }],
      inject: { kind: 'header', name: 'authorization', template: 'Bearer {{secret}}' },
    },
    ...overrides,
  };
}

describe('beginOptimisticProjectSecretSave', () => {
  test('adds a configured row to the cache before the request finishes', () => {
    const queryClient = new QueryClient();
    const original = response([secret()]);
    queryClient.setQueryData(QUERY_KEY, original);

    const context = beginOptimisticProjectSecretSave(queryClient, QUERY_KEY, input());

    expect(context.previous).toBe(original);
    const cached = queryClient.getQueryData<ProjectSecretsResponse>(QUERY_KEY);
    expect(cached?.items).toHaveLength(2);
    expect(cached?.items[1]).toMatchObject({
      identifier: 'NEW_TOKEN',
      configured: true,
      strategy: 'broker',
      consumer: 'http_broker',
      effective_source: 'shared',
    });
    expect(cached?.required).toEqual(['REQUIRED_TOKEN']);
    expect(cached?.can_manage).toBe(true);
  });

  test('updates an existing row without duplicating it', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(QUERY_KEY, response([secret()]));

    beginOptimisticProjectSecretSave(
      queryClient,
      QUERY_KEY,
      input({
        identifier: 'EXAMPLE_TOKEN',
        name: 'EXAMPLE_TOKEN',
        strategy: 'denied',
        consumer: null,
        deliveryStatus: 'disabled',
        egressPolicy: null,
      }),
    );

    const cached = queryClient.getQueryData<ProjectSecretsResponse>(QUERY_KEY);
    expect(cached?.items).toHaveLength(1);
    expect(cached?.items[0]).toMatchObject({
      identifier: 'EXAMPLE_TOKEN',
      secret_id: 'secret-1',
      strategy: 'denied',
      consumer: null,
      delivery_status: 'disabled',
    });
  });

  test('preserves the legacy bare-array cache shape', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<ProjectSecret[]>(QUERY_KEY, [secret()]);

    beginOptimisticProjectSecretSave(queryClient, QUERY_KEY, input());

    const cached = queryClient.getQueryData<ProjectSecret[]>(QUERY_KEY);
    expect(Array.isArray(cached)).toBe(true);
    expect(cached?.map((item) => item.identifier)).toEqual(['EXAMPLE_TOKEN', 'NEW_TOKEN']);
  });

  test('an empty cache stays empty and returns no snapshot', () => {
    const queryClient = new QueryClient();

    const context = beginOptimisticProjectSecretSave(queryClient, QUERY_KEY, input());

    expect(context.previous).toBeUndefined();
    expect(queryClient.getQueryData(QUERY_KEY)).toBeUndefined();
  });
});

describe('rollbackOptimisticProjectSecretSave', () => {
  test('restores the exact content that existed before the optimistic write', () => {
    const queryClient = new QueryClient();
    const original = response([secret()]);
    queryClient.setQueryData(QUERY_KEY, original);
    const { previous } = beginOptimisticProjectSecretSave(queryClient, QUERY_KEY, input());
    expect(queryClient.getQueryData<ProjectSecretsResponse>(QUERY_KEY)?.items).toHaveLength(2);

    rollbackOptimisticProjectSecretSave(queryClient, QUERY_KEY, previous);

    expect(queryClient.getQueryData(QUERY_KEY)).toEqual(original);
  });
});

describe('applyProjectSecretResponse', () => {
  test('replaces the optimistic row with the authoritative response', () => {
    const optimistic = response([
      secret({
        identifier: 'NEW_TOKEN',
        name: 'NEW_TOKEN',
        secret_id: null,
        updated_at: null,
        strategy: 'broker',
        consumer: 'http_broker',
      }),
    ]);
    const server = secret({
      identifier: 'NEW_TOKEN',
      name: 'NEW_TOKEN',
      secret_id: 'secret-server',
      updated_at: '2026-08-06T12:00:00.000Z',
      strategy: 'broker',
      consumer: 'http_broker',
    });

    const result = applyProjectSecretResponse(optimistic, server);

    expect(Array.isArray(result)).toBe(false);
    expect((result as ProjectSecretsResponse).items[0]).toEqual(server);
  });
});
