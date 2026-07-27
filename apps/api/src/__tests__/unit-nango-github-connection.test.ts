import { describe, expect, test } from 'bun:test';
import { NangoError } from '../projects/nango/errors';
import {
  buildAccountNangoTags,
  buildManagedNangoTags,
  decodeAccountGithubConnection,
  decodeManagedGithubConnection,
  nangoWebhookUrlOverride,
  parseAccountNangoTags,
} from '../projects/nango/github-connection';

const accountTags = buildAccountNangoTags({
  accountId: '6b70ddb0-a373-4291-85ca-31e306ac4f95',
  userId: '3bfc6305-421b-4bd8-b290-9d0e410e6eca',
  displayName: 'Acme Engineering',
  connectAttemptId: '9cf75b4a-790d-4e74-8da8-d6be32b3b598',
});

const accountConnection = {
  id: 1,
  connectionId: 'account-connection',
  integrationId: 'github-account',
  provider: 'github-app-oauth',
  errors: [],
  metadata: {},
  connectionConfig: {
    installation_id: '125146708',
    jwtToken: 'app-jwt-must-never-be-returned',
  },
  tags: accountTags,
  createdAt: '2026-07-27T17:00:00.000Z',
  updatedAt: '2026-07-27T17:01:00.000Z',
  lastFetchedAt: '2026-07-27T17:02:00.000Z',
  credentials: {
    type: 'CUSTOM',
    app: {
      type: 'APP',
      access_token: 'ghs_installation_token',
      expires_at: '2026-07-27T18:02:00.000Z',
      raw: {
        expires_at: '2026-07-27T18:02:00.000Z',
        permissions: { contents: 'write', metadata: 'read' },
        repository_selection: 'selected',
        token: 'duplicate-installation-token',
      },
    },
    user: {
      type: 'OAUTH2',
      access_token: 'ghu_user_token',
      refresh_token: 'ghr_refresh_token',
      expires_at: '2026-07-27T23:02:00.000Z',
      raw: { access_token: 'duplicate-user-token' },
    },
    raw: {},
  },
};

const managedConnection = {
  ...accountConnection,
  connectionId: 'managed-connection',
  integrationId: 'github-managed',
  provider: 'github-app',
  tags: buildManagedNangoTags({
    selectedByUserId: '3bfc6305-421b-4bd8-b290-9d0e410e6eca',
    displayName: 'Kortix Managed GitHub',
    connectAttemptId: '436b7337-728f-487f-a7e8-306a8fa5ea30',
  }),
  credentials: accountConnection.credentials.app,
};

describe('Nango GitHub connection tags', () => {
  test('builds and validates server-owned account tags', () => {
    expect(accountTags).toEqual({
      kortix_account_id: '6b70ddb0-a373-4291-85ca-31e306ac4f95',
      kortix_user_id: '3bfc6305-421b-4bd8-b290-9d0e410e6eca',
      kortix_purpose: 'account',
      kortix_display_name: 'Acme Engineering',
      kortix_connect_attempt_id: '9cf75b4a-790d-4e74-8da8-d6be32b3b598',
    });
    expect(parseAccountNangoTags(accountTags)).toEqual({
      accountId: '6b70ddb0-a373-4291-85ca-31e306ac4f95',
      userId: '3bfc6305-421b-4bd8-b290-9d0e410e6eca',
      purpose: 'account',
      displayName: 'Acme Engineering',
      connectAttemptId: '9cf75b4a-790d-4e74-8da8-d6be32b3b598',
    });
    expect(parseAccountNangoTags({ ...accountTags, kortix_purpose: 'managed' })).toBeNull();
  });

  test('uses only an HTTPS local development URL for the webhook override', () => {
    expect(nangoWebhookUrlOverride('https://random-words.trycloudflare.com/', true)).toBe(
      'https://random-words.trycloudflare.com/v1/webhooks/nango',
    );
    expect(nangoWebhookUrlOverride('http://localhost:8008', true)).toBeUndefined();
    expect(nangoWebhookUrlOverride('https://dev-api.kortix.com', false)).toBeUndefined();
    expect(nangoWebhookUrlOverride('https://user:pass@example.test', true)).toBeUndefined();
  });
});

describe('Nango GitHub credential decoding', () => {
  test('decodes account user and installation credentials without App JWT or raw fields', () => {
    const result = decodeAccountGithubConnection(accountConnection, {
      integrationId: 'github-account',
    });

    expect(result).toEqual({
      mode: 'account',
      connectionId: 'account-connection',
      integrationId: 'github-account',
      installationId: '125146708',
      installationToken: 'ghs_installation_token',
      installationTokenExpiresAt: '2026-07-27T18:02:00.000Z',
      userToken: 'ghu_user_token',
      userTokenExpiresAt: '2026-07-27T23:02:00.000Z',
      permissions: { contents: 'write', metadata: 'read' },
      repositorySelection: 'selected',
      tags: accountTags,
    });
    expect(JSON.stringify(result)).not.toContain('app-jwt-must-never-be-returned');
    expect(JSON.stringify(result)).not.toContain('ghr_refresh_token');
    expect(JSON.stringify(result)).not.toContain('duplicate-');
  });

  test('decodes a managed installation credential', () => {
    expect(
      decodeManagedGithubConnection(managedConnection, {
        integrationId: 'github-managed',
      }),
    ).toEqual({
      mode: 'managed',
      connectionId: 'managed-connection',
      integrationId: 'github-managed',
      installationId: '125146708',
      installationToken: 'ghs_installation_token',
      installationTokenExpiresAt: '2026-07-27T18:02:00.000Z',
      permissions: { contents: 'write', metadata: 'read' },
      repositorySelection: 'selected',
      tags: managedConnection.tags,
    });
  });

  test('rejects API-key, malformed, wrong-mode, wrong-integration, and wrong-provider credentials', () => {
    const invalidConnections = [
      {
        ...accountConnection,
        credentials: { type: 'API_KEY', apiKey: 'github_pat_secret', raw: {} },
      },
      {
        ...accountConnection,
        credentials: { type: 'CUSTOM', app: null, user: null, raw: {} },
      },
      { ...accountConnection, provider: 'github' },
      { ...accountConnection, integrationId: 'different-integration' },
      { ...accountConnection, credentials: managedConnection.credentials },
    ];

    for (const connection of invalidConnections) {
      expect(() =>
        decodeAccountGithubConnection(connection, {
          integrationId: 'github-account',
        }),
      ).toThrow(NangoError);
    }

    expect(() =>
      decodeManagedGithubConnection(
        { ...managedConnection, credentials: accountConnection.credentials },
        { integrationId: 'github-managed' },
      ),
    ).toThrow(NangoError);
  });
});
