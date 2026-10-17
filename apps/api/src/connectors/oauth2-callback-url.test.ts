import { describe, expect, test } from 'bun:test';
import { nativeOAuth2CallbackResponse, nativeOAuth2CallbackUrl } from './oauth2-callback-url';

describe('nativeOAuth2CallbackUrl', () => {
  test('uses the public API origin, not the internal request origin', () => {
    // Behind the ALB the API sees the internal origin over plain http. The
    // redirect_uri registered with an authorization server is the public one.
    expect(
      nativeOAuth2CallbackUrl(
        'http://dev-api-ecs-fargate.kortix.com/v1/projects/p/connections/c/oauth2/authorize',
        'https://dev-api.kortix.com',
      ),
    ).toBe('https://dev-api.kortix.com/v1/connectors/oauth2/callback');
  });

  test('strips a /v1 or /v1/router suffix from KORTIX_URL', () => {
    expect(nativeOAuth2CallbackUrl('http://internal/v1/x', 'https://api.kortix.com/v1')).toBe(
      'https://api.kortix.com/v1/connectors/oauth2/callback',
    );
    expect(
      nativeOAuth2CallbackUrl('http://internal/v1/x', 'https://api.kortix.com/v1/router/'),
    ).toBe('https://api.kortix.com/v1/connectors/oauth2/callback');
  });

  test('falls back to the request origin when no public URL is configured', () => {
    expect(nativeOAuth2CallbackUrl('http://localhost:8008/v1/projects/p', undefined)).toBe(
      'http://localhost:8008/v1/connectors/oauth2/callback',
    );
    expect(nativeOAuth2CallbackUrl('http://localhost:8008/v1/projects/p', '')).toBe(
      'http://localhost:8008/v1/connectors/oauth2/callback',
    );
    expect(nativeOAuth2CallbackUrl('http://localhost:8008/v1/projects/p', 'not a url')).toBe(
      'http://localhost:8008/v1/connectors/oauth2/callback',
    );
  });
});

describe('nativeOAuth2CallbackResponse', () => {
  test('a sign-in started without a return page (the CLI) says it connected', () => {
    expect(nativeOAuth2CallbackResponse({ ok: true, redirectUri: null })).toEqual({
      status: 200,
      body: 'Connected. You can close this tab and return to Kortix.',
    });
  });

  test('a failure without a return page names the reason', () => {
    expect(
      nativeOAuth2CallbackResponse({ ok: false, redirectUri: null, errorCode: 'invalid_state' }),
    ).toEqual({
      status: 400,
      body: 'OAuth2 authorization failed (invalid_state): this sign-in link was already used or has expired. Start the sign-in again.',
    });
    expect(
      nativeOAuth2CallbackResponse({ ok: false, redirectUri: null, errorCode: 'token_exchange_failed' }),
    ).toEqual({ status: 400, body: 'OAuth2 authorization failed (token_exchange_failed).' });
  });

  test('with a return page it redirects there with the result', () => {
    expect(
      nativeOAuth2CallbackResponse({
        ok: false,
        redirectUri: 'https://app.example.test/c?x=1',
        errorCode: 'access_denied',
      }),
    ).toEqual({
      status: 302,
      location: 'https://app.example.test/c?x=1&oauth2=error&oauth2_error=access_denied',
    });
    expect(
      nativeOAuth2CallbackResponse({ ok: true, redirectUri: 'https://app.example.test/c' }),
    ).toEqual({ status: 302, location: 'https://app.example.test/c?oauth2=connected' });
  });
});
