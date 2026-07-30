import { describe, expect, test } from 'bun:test';

import {
  authorizationOwnerTypeForStrategy,
  buildEasyConnectProfileDraft,
  buildEmailConnectorProfileSlug,
  connectorAuthorizationQueryKeys,
  connectorAuthorizationStrategyForProvider,
  connectorAuthorizationStrategyIsEditable,
  connectorAuthorizationUpdateIsPending,
  connectorSetupStatus,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  isConnectorProfileSlugAvailable,
  normalizeConnectorProfileSlug,
  proposeConnectorProfileSlug,
} from './connector-profile-form';

describe('connector profile slug proposal', () => {
  test('uses the provider app slug when the project has no matching profile', () => {
    expect(proposeConnectorProfileSlug('google_drive', ['slack'])).toBe('google_drive');
  });

  test('increments the suffix when the project has multiple profiles for one app', () => {
    expect(
      proposeConnectorProfileSlug('google_drive', [
        'google_drive',
        'google_drive-2',
        'google_drive-4',
      ]),
    ).toBe('google_drive-3');
  });

  test('normalizes an edited slug to the manifest format', () => {
    expect(normalizeConnectorProfileSlug('  Sales / Primary  ')).toBe('sales-primary');
  });

  test('keeps a valid trailing separator while the slug is edited', () => {
    expect(normalizeConnectorProfileSlug('sales-')).toBe('sales-');
  });

  test('matches the manifest slug length limit', () => {
    expect(normalizeConnectorProfileSlug('a'.repeat(129))).toHaveLength(128);
  });

  test('rejects an existing project slug', () => {
    expect(isConnectorProfileSlugAvailable('sales-primary', ['sales-primary'])).toBe(false);
    expect(isConnectorProfileSlugAvailable('sales-secondary', ['sales-primary'])).toBe(true);
  });
});

describe('Easy Connect profile draft', () => {
  test('keeps the provider app and sends the selected profile fields', () => {
    expect(
      buildEasyConnectProfileDraft(
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

describe('connector profile creation contract', () => {
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
      authorization_strategy: 'project',
      create_only: true,
    });
  });

  test('returns only the synchronization error for the created profile', () => {
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

  test('uses a collision-resistant identifier in email profile slugs', () => {
    expect(buildEmailConnectorProfileSlug('Support', '5c45ef44-a2df-4c55')).toBe(
      'email_support_5c45ef44a2df',
    );
    expect(buildEmailConnectorProfileSlug('Support', '11111111-2222-3333')).not.toBe(
      buildEmailConnectorProfileSlug('Support', '44444444-5555-6666'),
    );
  });
});

describe('connector setup status', () => {
  const connector = {
    status: 'active' as const,
    authSecret: 'TOKEN',
    secretSet: false,
    authorizationStrategy: 'project' as const,
  };

  test('uses the shared secret state only for project authorization', () => {
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
  test('maps each strategy to its only valid authorization owner', () => {
    expect(authorizationOwnerTypeForStrategy('project')).toBe('project');
    expect(authorizationOwnerTypeForStrategy('user')).toBe('member');
  });

  test('forces managed providers to project authorization', () => {
    expect(connectorAuthorizationStrategyForProvider('channel', 'user')).toBe('project');
    expect(connectorAuthorizationStrategyForProvider('computer', 'user')).toBe('project');
    expect(connectorAuthorizationStrategyForProvider('pipedream', 'user')).toBe('user');
    expect(connectorAuthorizationStrategyForProvider('openapi', 'user')).toBe('user');
  });

  test('locks every channel and computer profile regardless of slug', () => {
    expect(connectorAuthorizationStrategyIsEditable('channel')).toBe(false);
    expect(connectorAuthorizationStrategyIsEditable('computer')).toBe(false);
    expect(connectorAuthorizationStrategyIsEditable('pipedream')).toBe(true);
    expect(connectorAuthorizationStrategyIsEditable('http')).toBe(true);
  });

  test('keeps controls locked until the refreshed strategy matches the submission', () => {
    expect(connectorAuthorizationUpdateIsPending('project', 'user', false)).toBe(true);
    expect(connectorAuthorizationUpdateIsPending('user', 'user', false)).toBe(false);
    expect(connectorAuthorizationUpdateIsPending('user', null, true)).toBe(true);
    expect(connectorAuthorizationUpdateIsPending('user', null, false)).toBe(false);
  });

  test('returns every cache affected by connector authorization changes', () => {
    expect(connectorAuthorizationQueryKeys('project-1')).toEqual([
      ['project-connectors', 'project-1'],
      ['connector-profiles', 'project-1'],
      ['connector-profiles-all', 'project-1'],
      ['session-scope-catalog', 'project-1'],
    ]);
  });
});
