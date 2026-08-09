import { describe, expect, test } from 'bun:test';

import {
  ENVIRONMENT_ACCESS_COOKIE,
  ENVIRONMENT_HEALTH_PATH,
  ENVIRONMENT_PROTECTION_USERNAME,
  authorizeEnvironment,
  deriveEnvironmentAccessCookie,
} from './environment-protection';

function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

describe('authorizeEnvironment', () => {
  test('allows all requests when protection is disabled', () => {
    expect(
      authorizeEnvironment({
        enabled: 'false',
        password: undefined,
        authorization: null,
        pathname: '/',
      }),
    ).toEqual({ allowed: true, source: 'disabled' });
  });

  test('always allows the ECS health path', () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: undefined,
        authorization: null,
        pathname: ENVIRONMENT_HEALTH_PATH,
      }),
    ).toEqual({ allowed: true, source: 'health' });
  });

  test('fails closed when protection is enabled without a password', () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: undefined,
        authorization: null,
        pathname: '/',
      }),
    ).toEqual({ allowed: false, reason: 'configuration_error' });
  });

  test('rejects missing and malformed credentials', () => {
    for (const authorization of [null, 'Bearer token', 'Basic not-base64%%%']) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization,
          pathname: '/',
        }),
      ).toEqual({ allowed: false, reason: 'credentials_required' });
    }
  });

  test('rejects a wrong username or password', () => {
    for (const authorization of [
      basic('other', 'test-password'),
      basic(ENVIRONMENT_PROTECTION_USERNAME, 'wrong-password'),
    ]) {
      expect(
        authorizeEnvironment({
          enabled: 'true',
          password: 'test-password',
          authorization,
          pathname: '/projects',
        }),
      ).toEqual({ allowed: false, reason: 'credentials_required' });
    }
  });

  test('accepts the configured username and password', () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: basic(ENVIRONMENT_PROTECTION_USERNAME, 'test-password'),
        pathname: '/projects',
      }),
    ).toEqual({ allowed: true, source: 'basic' });
  });

  test('accepts one signed parent-domain cookie across protected subdomains', async () => {
    const expectedAccessCookie = await deriveEnvironmentAccessCookie('test-password');
    expect(expectedAccessCookie).not.toContain('test-password');
    expect(ENVIRONMENT_ACCESS_COOKIE).toBe('__Secure-kortix_test_access');
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: null,
        accessCookie: expectedAccessCookie,
        expectedAccessCookie,
        pathname: '/projects',
      }),
    ).toEqual({ allowed: true, source: 'cookie' });
  });

  test('rejects a cookie derived from another password', async () => {
    expect(
      authorizeEnvironment({
        enabled: 'true',
        password: 'test-password',
        authorization: null,
        accessCookie: await deriveEnvironmentAccessCookie('wrong-password'),
        expectedAccessCookie: await deriveEnvironmentAccessCookie('test-password'),
        pathname: '/projects',
      }),
    ).toEqual({ allowed: false, reason: 'credentials_required' });
  });
});
