import { qk } from '@kortix/sdk/react';
import { describe, expect, test } from 'bun:test';

import {
  buildEasyConnectConnectorDraft,
  buildEmailConnectorConnectionSlug,
  connectionOwnerTypeForStrategy,
  connectorAuthorizationStrategyForProvider,
  connectorAuthorizationStrategyIsEditable,
  connectorAuthorizationUpdateIsPending,
  connectorConnectionQueryKeys,
  connectorConnectionSlugAfterNameChange,
  connectorSetupStatus,
  connectorSyncErrorForSlug,
  createOnlyConnectorDraft,
  isConnectorConnectionSlugAvailable,
  normalizeConnectorConnectionSlug,
  proposeConnectorConnectionName,
  proposeConnectorConnectionSlug,
} from './connector-connection-form';

describe('connector slug proposal', () => {
  test('generates the slug from the display name with a random suffix, always', () => {
    // Marko, 2026-09-03: "unique slug, always sentry-<random>". A bare app slug
    // collided with a previous attempt's leftovers at Composio and a `-1`
    // suffix collided with the next person's; random does neither.
    expect(proposeConnectorConnectionSlug('Gmail Read Only', ['slack'], () => 'k3x9q2')).toBe(
      'gmail-read-only-k3x9q2',
    );
    expect(proposeConnectorConnectionSlug('Sentry', [])).toMatch(/^sentry-[0-9a-z]{6}$/);
  });

  test('draws again when the random suffix is already taken', () => {
    const draws = ['aaaaaa', 'bbbbbb'];
    expect(
      proposeConnectorConnectionSlug('Sentry', ['sentry-aaaaaa'], () => draws.shift() ?? 'zzzzzz'),
    ).toBe('sentry-bbbbbb');
  });

  test('proposes "<name> N" for the Nth connection to the same app', () => {
    expect(proposeConnectorConnectionName('Sentry', [])).toBe('Sentry');
    expect(proposeConnectorConnectionName('Sentry', ['sentry-k3x9q2'])).toBe('Sentry 2');
    expect(proposeConnectorConnectionName('Sentry', ['sentry-k3x9q2', 'sentry-p0p0p0'])).toBe(
      'Sentry 3',
    );
    // `sentryfoo` is a different app, not another Sentry.
    expect(proposeConnectorConnectionName('Sentry', ['sentryfoo-abc'])).toBe('Sentry');
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
    ).toMatch(/^gmail-read-only-[0-9a-z]{6}$/);
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

  test('rejects an existing project slug', () => {
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
      authorization_strategy: 'project',
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

  // Prod 2026-08-28: 6 of 6 GitHub connections had a null `connected_account_id`
  // — authorization was never completed — and no GitHub tool call had ever run,
  // yet the connector grid showed a checkmark. `needs_auth` used to fall
  // through to the secretSet branch and read as `connected`.
  test('an authorization that never completed is setup that never finished', () => {
    expect(connectorSetupStatus({ ...connector, status: 'needs_auth' })).toBe('needs_setup');
    // Even with a credential present it is NOT connected — the credential is
    // not the thing that is missing.
    expect(connectorSetupStatus({ ...connector, status: 'needs_auth', secretSet: true })).toBe(
      'needs_setup',
    );
  });

  test('error still outranks needs_auth', () => {
    expect(connectorSetupStatus({ ...connector, status: 'error' })).toBe('error');
  });

  test('keeps error and no-auth states independent of credential ownership', () => {
    expect(connectorSetupStatus({ ...connector, status: 'error' })).toBe('error');
    expect(connectorSetupStatus({ ...connector, authSecret: null })).toBe('no_auth');
  });
});

describe('connector authorization strategy controls', () => {
  test('maps each strategy to its only valid connection owner', () => {
    expect(connectionOwnerTypeForStrategy('project')).toBe('project');
    expect(connectionOwnerTypeForStrategy('user')).toBe('member');
  });

  test('forces managed providers to project authorization', () => {
    expect(connectorAuthorizationStrategyForProvider('channel', 'user')).toBe('project');
    expect(connectorAuthorizationStrategyForProvider('computer', 'user')).toBe('project');
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
    expect(connectorAuthorizationUpdateIsPending('project', 'user', false)).toBe(true);
    expect(connectorAuthorizationUpdateIsPending('user', 'user', false)).toBe(false);
    expect(connectorAuthorizationUpdateIsPending('user', null, true)).toBe(true);
    expect(connectorAuthorizationUpdateIsPending('user', null, false)).toBe(false);
  });

  test('returns every cache affected by connection changes', () => {
    expect(connectorConnectionQueryKeys('project-1')).toEqual([
      qk.project.connectors('project-1'),
      ['connections', 'project-1'],
      ['connections-all', 'project-1'],
      ['session-scope-catalog', 'project-1'],
    ]);
  });
});
