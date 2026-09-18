import { describe, expect, test } from 'bun:test';

import { buildToolConnectorDraft, requestToolAuthorization } from './use-tool-connect';

describe('buildToolConnectorDraft', () => {
  test('uses the selected connector identity instead of the provider slug', () => {
    // No `authorizationStrategy` — ownership is an account property
    // (`owner_type`), not a connector-level mode. Adding a tool from the
    // catalogue always authorizes the PROJECT's shared account; a personal
    // account is added afterwards from the connector's Accounts tab.
    expect(
      buildToolConnectorDraft({
        appSlug: 'notion',
        appName: 'Notion',
        provider: 'composio',
        connectorName: 'Product workspace',
        connectorSlug: 'notion-product',
      }),
    ).toEqual({
      slug: 'notion-product',
      name: 'Product workspace',
      provider: 'composio',
      app: 'notion',
      account: 'default',
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
  };

  test('always authorizes the project shared account — web never calls it for a member account', async () => {
    const calls: string[] = [];
    const result = await requestToolAuthorization('project-1', input, {
      connectProject: async (_projectId, slug) => {
        calls.push(`project-connect:${slug}`);
        return { connectUrl: 'https://connect.example/project' };
      },
    });

    expect(result).toEqual({ connectUrl: 'https://connect.example/project' });
    expect(calls).toEqual(['project-connect:notion-product']);
  });
});
