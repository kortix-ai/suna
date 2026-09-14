import { describe, expect, test } from 'bun:test';
import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import { oauth2RedirectDrifted, reregisteredOAuth2Application } from './oauth2-redirect-drift';

const app = (over: Partial<OAuth2ApplicationInput> = {}): OAuth2ApplicationInput => ({
  client_id: 'DyKD-gONBpmszHPM',
  token_endpoint_auth_method: 'none',
  token_url: 'https://mcp.canva.com/token',
  redirect_uri: 'https://old-tunnel.trycloudflare.com/v1/connectors/oauth2/callback',
  registration_endpoint: 'https://mcp.canva.com/register',
  ...over,
});

const CURRENT = 'https://beer-max-new.trycloudflare.com/v1/connectors/oauth2/callback';

describe('oauth2RedirectDrifted — a rotated public origin must be caught BEFORE authorize', () => {
  test('a stored client registered under another callback has drifted', () => {
    // The dev quick tunnel rotates on every stack restart; the authorization
    // server byte-matches redirect_uri against the registered one and answers
    // "Invalid redirect URI." (Jay, 2026-09-14, Canva MCP.)
    expect(oauth2RedirectDrifted(app(), CURRENT)).toBe(true);
  });

  test('a matching callback is not drift', () => {
    expect(oauth2RedirectDrifted(app({ redirect_uri: CURRENT }), CURRENT)).toBe(false);
  });

  test('without a registration endpoint there is nothing to heal — no drift claim', () => {
    // Manually configured clients (user-created OAuth apps) have no RFC 7591
    // endpoint; flagging them would dead-end into an impossible re-register.
    expect(oauth2RedirectDrifted(app({ registration_endpoint: undefined }), CURRENT)).toBe(false);
  });

  test('legacy applications with no recorded redirect_uri never claim drift', () => {
    expect(oauth2RedirectDrifted(app({ redirect_uri: undefined }), CURRENT)).toBe(false);
  });
});

describe('reregisteredOAuth2Application — the fresh client replaces the stale one wholesale', () => {
  test('adopts the issued client and records the current callback', () => {
    const healed = reregisteredOAuth2Application(
      app({ client_secret: undefined }),
      {
        client_id: 'fresh-client',
        client_secret: 's3cret',
        token_endpoint_auth_method: 'client_secret_basic',
        registration_client_uri: 'https://mcp.canva.com/register/fresh-client',
        registration_access_token: 'rat-token',
      },
      CURRENT,
    );
    expect(healed.client_id).toBe('fresh-client');
    expect(healed.client_secret).toBe('s3cret');
    expect(healed.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(healed.redirect_uri).toBe(CURRENT);
    expect(healed.registration_client_uri).toBe('https://mcp.canva.com/register/fresh-client');
    expect(healed.registration_access_token).toBe('rat-token');
    // Endpoints and issuer survive — only the client identity was reissued.
    expect(healed.token_url).toBe('https://mcp.canva.com/token');
    expect(healed.registration_endpoint).toBe('https://mcp.canva.com/register');
  });

  test('a public (none) fresh client drops the stale secret and RFC 7592 handles', () => {
    const healed = reregisteredOAuth2Application(
      app({
        client_secret: 'stale-secret',
        registration_client_uri: 'https://mcp.canva.com/register/old',
        registration_access_token: 'old-rat',
      }),
      { client_id: 'fresh-public', token_endpoint_auth_method: 'none' },
      CURRENT,
    );
    expect(healed.client_id).toBe('fresh-public');
    expect(healed.client_secret).toBeUndefined();
    expect(healed.registration_client_uri).toBeUndefined();
    expect(healed.registration_access_token).toBeUndefined();
  });
});
