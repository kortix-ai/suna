import { describe, expect, test } from 'bun:test';
import {
  createStoredDelegatedCredential,
  resolveStoredDelegatedCredential,
} from './oauth2-delegated';

const application = {
  token_url: 'https://identity.example.com/token',
  client_id: 'public-client',
  token_endpoint_auth_method: 'none' as const,
};

describe('delegated OAuth2 connector credential', () => {
  test('returns a fresh access token without a provider request', async () => {
    const value = createStoredDelegatedCredential(application, {
      access_token: 'fresh',
      refresh_token: 'refresh-old',
      token_type: 'Bearer',
      expires_at: 2_000_000,
      scopes: [],
    });
    const resolved = await resolveStoredDelegatedCredential(value, {
      now: () => 1_000_000,
      fetchImpl: async () => {
        throw new Error('not expected');
      },
    });
    expect(resolved).toEqual({ accessToken: 'fresh', updatedValue: null });
  });

  test('refreshes an expiring token and persists refresh-token rotation', async () => {
    const value = createStoredDelegatedCredential(application, {
      access_token: 'expired',
      refresh_token: 'refresh-old',
      token_type: 'Bearer',
      expires_at: 1_000_000,
      scopes: [],
    });
    const resolved = await resolveStoredDelegatedCredential(value, {
      now: () => 1_000_000,
      fetchImpl: async () =>
        Response.json({
          access_token: 'fresh',
          refresh_token: 'refresh-new',
          expires_in: 3600,
        }),
    });
    expect(resolved.accessToken).toBe('fresh');
    expect(resolved.updatedValue).toContain('refresh-new');
    expect(resolved.updatedValue).not.toContain('refresh-old');
  });
});
