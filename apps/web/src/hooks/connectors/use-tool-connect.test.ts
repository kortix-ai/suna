import { describe, expect, test } from 'bun:test';

import { buildToolConnectorDraft, requestToolAuthorization } from './use-tool-connect';

describe('buildToolConnectorDraft', () => {
  test('uses the selected profile identity instead of the provider slug', () => {
    expect(
      buildToolConnectorDraft({
        appSlug: 'notion',
        appName: 'Notion',
        profileName: 'Product workspace',
        profileSlug: 'notion-product',
        authorizationStrategy: 'user',
      }),
    ).toEqual({
      slug: 'notion-product',
      name: 'Product workspace',
      provider: 'pipedream',
      app: 'notion',
      account: 'default',
      authorization_strategy: 'user',
      create_only: true,
    });
  });
});

describe('requestToolAuthorization', () => {
  const input = {
    appSlug: 'notion',
    appName: 'Notion',
    profileName: 'Product workspace',
    profileSlug: 'notion-product',
    authorizationStrategy: 'user' as const,
  };

  test('uses only member authorization endpoints for a user-owned profile', async () => {
    const calls: string[] = [];
    const result = await requestToolAuthorization('project-1', input, {
      connectProject: async () => {
        calls.push('project-connect');
        return {};
      },
      reconcileMember: async (_projectId, authorization) => {
        calls.push(`member-reconcile:${authorization.connector_alias}:${authorization.label}`);
        return {
          profile_id: 'authorization-1',
          connector_alias: authorization.connector_alias,
          owner_type: 'member',
          owner_id: 'user-1',
          label: authorization.label,
          status: 'active',
          is_default: true,
          metadata: {},
        };
      },
      connectMember: async (_projectId, authorizationId) => {
        calls.push(`member-connect:${authorizationId}`);
        return { token: 'token', app: 'notion' };
      },
    });

    expect(result).toEqual({
      token: 'token',
      app: 'notion',
      authorizationId: 'authorization-1',
    });
    expect(calls).toEqual([
      'member-reconcile:notion-product:Product workspace',
      'member-connect:authorization-1',
    ]);
  });

  test('uses the project endpoint for a project-owned profile', async () => {
    const calls: string[] = [];
    const result = await requestToolAuthorization(
      'project-1',
      { ...input, authorizationStrategy: 'project' },
      {
        connectProject: async (_projectId, slug) => {
          calls.push(`project-connect:${slug}`);
          return { token: 'token', app: 'notion' };
        },
        reconcileMember: async () => {
          throw new Error('member reconciliation must not run');
        },
        connectMember: async () => {
          throw new Error('member connection must not run');
        },
      },
    );

    expect(result).toEqual({ token: 'token', app: 'notion', authorizationId: null });
    expect(calls).toEqual(['project-connect:notion-product']);
  });
});
