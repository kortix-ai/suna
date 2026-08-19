import { describe, expect, test } from 'bun:test';
import { nativeOAuth2CallbackUrl } from './oauth2-callback-url';

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
