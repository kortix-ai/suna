import { describe, expect, test } from 'bun:test';
import { qk } from '@kortix/sdk/react';

import {
  connectionOwnerTypeForStrategy,
  buildEasyConnectConnectorDraft,
  buildEmailConnectorConnectionSlug,
  connectorConnectionQueryKeys,
  connectorAuthorizationStrategyForProvider,
  connectorAuthorizationStrategyIsEditable,
  connectorAuthorizationUpdateIsPending,
  connectorConnectionSlugAfterNameChange,
  connectorSetupStatus,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  isConnectorConnectionSlugAvailable,
  normalizeConnectorConnectionSlug,
  proposeConnectorConnectionSlug,
} from './connector-connection-form';

describe('connector slug proposal', () => {
  test('generates the slug from the display name', () => {
    expect(proposeConnectorConnectionSlug('Gmail Read Only', ['slack'])).toBe('gmail-read-only');
  });

  test('uses the first available numeric suffix after a collision', () => {
    expect(
      proposeConnectorConnectionSlug('Gmail Read Only', [
        'gmail-read-only',
        'gmail-read-only-1',
        'gmail-read-only-3',
      ]),
    ).toBe('gmail-read-only-2');
  });

  test('keeps an edited slug when the display name changes', () => {
    expect(
      connectorConnectionSlugAfterNameChange({
        displayName: 'Gmail Read Only',
        currentSlug: 'private-inbox',
        existingSlugs: [],
        slugEdited: true,
      }),
    ).toBe('private-inbox');
  });

  test('updates an unedited slug when the display name changes', () => {
    expect(
      connectorConnectionSlugAfterNameChange({
        displayName: 'Gmail Read Only',
        currentSlug: 'gmail',
        existingSlugs: ['gmail-read-only'],
        slugEdited: false,
      }),
    ).toBe('gmail-read-only-1');
  });

  test('normalizes an edited slug to the manifest format', () => {
    expect(normalizeConnectorConnectionSlug('  Sales / Primary  ')).toBe('sales-primary');
  });

  test('keeps a valid trailing separator while the slug is edited', () => {
    expect(normalizeConnectorConnectionSlug('sales-')).toBe('sales-');
  });

  test('matches the manifest slug length limit', () => {
    expect(normalizeConnectorConnectionSlug('a'.repeat(129))).toHaveLength(128);
  });

  test('rejects an existing workspace slug', () => {
    expect(isConnectorConnectionSlugAvailable('sales-primary', ['sales-primary'])).toBe(false);
    expect(isConnectorConnectionSlugAvailable('sales-secondary', ['sales-primary'])).toBe(true);
  });
});

describe('Easy Connect connection draft', () => {
  test('keeps the provider app and sends the selected connection fields', () => {
    expect(
      buildEasyConnectConnectorDraft(
        { slug: 'google_drive', name: 'Google Drive' },
        {
          name: 'Finance Drive',
          slug: 'google_drive-finance',
          authorizationStrategy: 'user',
        },
      ),
    ).toEqual({
      slug: 'google_drive-finance',
      name: 'Finance Drive',
      provider: 'pipedream',
      app: 'google_drive',
      account: 'default',
      authorization_strategy: 'user',
      create_only: true,
    });
  });
});

describe('connector creation contract', () => {
  test('forces create-only mode and the provider-compatible authorization strategy', () => {
    expect(
      createOnlyConnectorDraft({
        slug: 'inbox',
        provider: 'channel',
        platform: 'email',
        authorization_strategy: 'user',
      }),
    ).toEqual({
      slug: 'inbox',
      provider: 'channel',
      platform: 'email',
      authorization_strategy: 'workspace',
      create_only: true,
    });
  });

  test('returns only the synchronization error for the created connection', () => {
    const result = {
      sync: {
        synced: 1,
        errors: [
          { slug: 'one', error: 'first error' },
          { slug: 'two', error: 'second error' },
        ],
      },
    };

    expect(connectorSyncErrorForSlug(result, 'two')).toBe('second error');
    expect(connectorSyncErrorForSlug(result, 'three')).toBeNull();
  });

  test('uses a collision-resistant identifier in email connector slugs', () => {
    expect(buildEmailConnectorConnectionSlug('Support', '5c45ef44-a2df-4c55')).toBe(
      'email_support_5c45ef44a2df',
    );
    expect(buildEmailConnectorConnectionSlug('Support', '11111111-2222-3333')).not.toBe(
      buildEmailConnectorConnectionSlug('Support', '44444444-5555-6666'),
    );
  });
});

describe('connector setup status', () => {
  const connector = {
    status: 'active' as const,
    authSecret: 'TOKEN',
    secretSet: false,
    authorizationStrategy: 'workspace' as const,
  };

  test('uses the shared secret state only for workspace authorization', () => {
    expect(connectorSetupStatus(connector)).toBe('needs_setup');
    expect(connectorSetupStatus({ ...connector, secretSet: true })).toBe('connected');
  });

  test('does not infer a user authorization state from the shared secret', () => {
    expect(connectorSetupStatus({ ...connector, authorizationStrategy: 'user' })).toBe(
      'user_managed',
    );
    expect(
      connectorSetupStatus({
        ...connector,
        authorizationStrategy: 'user',
        secretSet: true,
      }),
    ).toBe('user_managed');
  });

  test('keeps error and no-auth states independent of credential ownership', () => {
    expect(connectorSetupStatus({ ...connector, status: 'error' })).toBe('error');
    expect(connectorSetupStatus({ ...connector, authSecret: null })).toBe('no_auth');
  });
});

describe('connector authorization strategy controls', () => {
  test('maps each strategy to its only valid connection owner', () => {
    expect(connectionOwnerTypeForStrategy('workspace')).toBe('workspace');
    expect(connectionOwnerTypeForStrategy('user')).toBe('member');
  });

  test('forces managed providers to workspace authorization', () => {
    expect(connectorAuthorizationStrategyForProvider('channel', 'user')).toBe('workspace');
    expect(connectorAuthorizationStrategyForProvider('computer', 'user')).toBe('workspace');
    expect(connectorAuthorizationStrategyForProvider('pipedream', 'user')).toBe('user');
    expect(connectorAuthorizationStrategyForProvider('openapi', 'user')).toBe('user');
  });

  test('locks every channel and computer connection regardless of slug', () => {
    expect(connectorAuthorizationStrategyIsEditable('channel')).toBe(false);
    expect(connectorAuthorizationStrategyIsEditable('computer')).toBe(false);
    expect(connectorAuthorizationStrategyIsEditable('pipedream')).toBe(true);
    expect(connectorAuthorizationStrategyIsEditable('http')).toBe(true);
  });

  test('keeps controls locked until the refreshed strategy matches the submission', () => {
    expect(connectorAuthorizationUpdateIsPending('workspace', 'user', false)).toBe(true);
    expect(connectorAuthorizationUpdateIsPending('user', 'user', false)).toBe(false);
    expect(connectorAuthorizationUpdateIsPending('user', null, true)).toBe(true);
    expect(connectorAuthorizationUpdateIsPending('user', null, false)).toBe(false);
  });

  test('returns every cache affected by connection changes', () => {
    expect(connectorConnectionQueryKeys('workspace-1')).toEqual([
      qk.workspace.connectors('workspace-1'),
      ['connections', 'workspace-1'],
      ['connections-all', 'workspace-1'],
      ['session-scope-catalog', 'workspace-1'],
    ]);
  });
});
