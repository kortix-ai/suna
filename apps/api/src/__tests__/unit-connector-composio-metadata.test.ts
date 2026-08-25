import { describe, expect, test } from 'bun:test';
import {
  composioConnectedAccountId,
  composioConnectionIsNoAuth,
  composioConnectionMetadata,
} from '../connectors/db-deps';

describe('Composio connector connection metadata', () => {
  test('persists only non-secret connection-scoped authorization metadata', () => {
    const metadata = composioConnectionMetadata({
      toolkit: 'github',
      stableUserId: 'kortix-connection:11111111-1111-4111-8111-111111111111',
      sessionId: 'session_1',
      authRequestId: 'request_1',
      connectedAccountId: 'account_1',
      isNoAuth: false,
    });

    expect(metadata).toEqual({
      provider: 'composio',
      toolkit: 'github',
      stable_user_id: 'kortix-connection:11111111-1111-4111-8111-111111111111',
      session_id: 'session_1',
      auth_request_id: 'request_1',
      connected_account_id: 'account_1',
      is_no_auth: false,
      requesting_session_id: null,
    });
    expect(Object.keys(metadata)).not.toContain('api_key');
    expect(Object.keys(metadata)).not.toContain('credential');
  });

  test('records the Kortix session that asked, distinctly from the provider session', () => {
    // `session_id` is Composio's Tool Router session (`trs_…`). The Kortix
    // session that minted the link is a different id under a different key, and
    // finalize reads it to tell that agent the account landed. Collapsing the
    // two would make finalize try to resume a Composio session id.
    const metadata = composioConnectionMetadata({
      toolkit: 'gmail',
      stableUserId: 'kortix-connection:33333333-3333-4333-8333-333333333333',
      sessionId: 'trs_provider_session',
      isNoAuth: false,
      requestingSessionId: '44444444-4444-4444-8444-444444444444',
    });

    expect(metadata.session_id).toBe('trs_provider_session');
    expect(metadata.requesting_session_id).toBe('44444444-4444-4444-8444-444444444444');
  });

  test('accepts no-auth toolkits without a connected account', () => {
    const metadata = composioConnectionMetadata({
      toolkit: 'composio',
      stableUserId: 'kortix-connection:22222222-2222-4222-8222-222222222222',
      sessionId: 'session_2',
      isNoAuth: true,
    });

    expect(composioConnectionIsNoAuth(metadata)).toBe(true);
    expect(composioConnectedAccountId(metadata)).toBeNull();
  });

  test('rejects connected-account metadata from another provider', () => {
    expect(
      composioConnectedAccountId({
        provider: 'pipedream',
        connected_account_id: 'account_1',
      }),
    ).toBeNull();
  });
});
