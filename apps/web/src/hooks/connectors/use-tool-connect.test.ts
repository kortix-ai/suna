import { describe, expect, test } from 'bun:test';

import { buildToolConnectorDraft, requestToolAuthorization } from './use-tool-connect';

describe('buildToolConnectorDraft', () => {
  test('uses the selected connector identity instead of the provider slug', () => {
    expect(
      buildToolConnectorDraft({
        appSlug: 'notion',
        appName: 'Notion',
        connectorName: 'Product workspace',
        connectorSlug: 'notion-product',
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
    connectorName: 'Product workspace',
    connectorSlug: 'notion-product',
    authorizationStrategy: 'user' as const,
  };

  test('uses only member connection endpoints for a user-owned connector', async () => {
    const calls: string[] = [];
    const result = await requestToolAuthorization('project-1', input, {
      connectWorkspace: async () => {
        calls.push('project-connect');
        return {};
      },
      reconcileMember: async (_workspaceId, connection) => {
        calls.push(`member-reconcile:${connection.connector_alias}:${connection.label}`);
        return {
          connection_id: 'connection-1',
          connector_alias: connection.connector_alias,
          owner_type: 'member',
          owner_id: 'user-1',
          label: connection.label,
          status: 'active',
          is_default: true,
          metadata: {},
        };
      },
      connectMember: async (_workspaceId, connectionId) => {
        calls.push(`member-connect:${connectionId}`);
        return { token: 'token', app: 'notion' };
      },
    });

    expect(result).toEqual({
      token: 'token',
      app: 'notion',
      connectionId: 'connection-1',
    });
    expect(calls).toEqual([
      'member-reconcile:notion-product:Product workspace',
      'member-connect:connection-1',
    ]);
  });

  test('uses the workspace endpoint for a workspace-owned connector', async () => {
    const calls: string[] = [];
    const result = await requestToolAuthorization(
      'project-1',
      { ...input, authorizationStrategy: 'workspace' },
      {
        connectWorkspace: async (_workspaceId, slug) => {
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

    expect(result).toEqual({ token: 'token', app: 'notion', connectionId: null });
    expect(calls).toEqual(['project-connect:notion-product']);
  });
});
