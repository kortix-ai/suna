import { describe, expect, test } from 'bun:test';

import { renderWebEnvironment } from './render-web-env.mjs';

function profile(name) {
  const host =
    name === 'dev' ? 'dev.kortix.com' : name === 'staging' ? 'staging.kortix.com' : 'kortix.com';
  const apiHost =
    name === 'dev'
      ? 'dev-api.kortix.com'
      : name === 'staging'
        ? 'staging-api.kortix.com'
        : 'api.kortix.com';
  return {
    NEXT_PUBLIC_APP_URL: `https://${host}`,
    NEXT_PUBLIC_BACKEND_URL: `https://${apiHost}/v1`,
    NEXT_PUBLIC_SUPABASE_URL: `https://${name}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `${name}-anon`,
    WEB_PROTECTION_PASSWORD: 'shared-password',
  };
}

describe('renderWebEnvironment', () => {
  test('protects dev and staging with the same supplied secret', () => {
    for (const name of ['dev', 'staging']) {
      const payload = renderWebEnvironment(name, profile(name));
      expect(payload.WEB_PROTECTION_ENABLED).toBe('true');
      expect(payload.WEB_PROTECTION_PASSWORD).toBe('shared-password');
      expect(payload.BACKEND_URL).toBe(profile(name).NEXT_PUBLIC_BACKEND_URL);
    }
  });

  test('keeps production public and omits the protection password', () => {
    const payload = renderWebEnvironment('prod', profile('prod'));
    expect(payload.WEB_PROTECTION_ENABLED).toBe('false');
    expect(payload).not.toHaveProperty('WEB_PROTECTION_PASSWORD');
  });

  test('copies only explicitly allowed optional values', () => {
    const payload = renderWebEnvironment('dev', {
      ...profile('dev'),
      EDGE_CONFIG: 'edge-connection',
      VERCEL_API_TOKEN: 'edge-write-token',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    });
    expect(payload.EDGE_CONFIG).toBe('edge-connection');
    expect(payload.VERCEL_API_TOKEN).toBe('edge-write-token');
    expect(payload).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  test('rejects an environment that points at another data plane', () => {
    expect(() =>
      renderWebEnvironment('staging', {
        ...profile('staging'),
        NEXT_PUBLIC_BACKEND_URL: 'https://dev-api.kortix.com/v1',
      }),
    ).toThrow('NEXT_PUBLIC_BACKEND_URL must target https://staging-api.kortix.com');
  });

  test('fails closed when a protected profile has no password', () => {
    const environment = profile('dev');
    environment.WEB_PROTECTION_PASSWORD = undefined;
    expect(() => renderWebEnvironment('dev', environment)).toThrow(
      'WEB_PROTECTION_PASSWORD is required',
    );
  });
});
