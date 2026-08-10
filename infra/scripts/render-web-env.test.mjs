import { describe, expect, test } from 'bun:test';

import { renderWebEnvironment } from './render-web-env.mjs';

function profile(name) {
  const host =
    name === 'dev' || name === 'preview'
      ? 'dev.kortix.com'
      : name === 'staging'
        ? 'staging.kortix.com'
        : 'kortix.com';
  const apiHost =
    name === 'dev' || name === 'preview'
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
  test('uses the canonical Dev host and isolated staging and production ECS hosts', () => {
    expect(renderWebEnvironment('dev', profile('dev')).NEXT_PUBLIC_APP_URL).toBe(
      'https://dev.kortix.com',
    );
    expect(renderWebEnvironment('staging', profile('staging')).NEXT_PUBLIC_APP_URL).toBe(
      'https://staging-fe-ecs.kortix.com',
    );
    expect(renderWebEnvironment('prod', profile('prod')).NEXT_PUBLIC_APP_URL).toBe(
      'https://prod-fe-ecs.kortix.com',
    );
  });

  test('protects dev and staging with the same supplied secret', () => {
    for (const name of ['preview', 'dev', 'staging']) {
      const payload = renderWebEnvironment(name, profile(name));
      expect(payload.WEB_PROTECTION_ENABLED).toBe('true');
      expect(payload.WEB_PROTECTION_PASSWORD).toBe('shared-password');
      expect(payload.BACKEND_URL).toBe(profile(name).NEXT_PUBLIC_BACKEND_URL);
    }
  });

  test('limits preview to public configuration and the shared protection password', () => {
    const payload = renderWebEnvironment('preview', {
      ...profile('preview'),
      EDGE_CONFIG: 'edge-connection',
      EDGE_CONFIG_ID: 'edge-id',
      VERCEL_API_TOKEN: 'edge-write-token',
      NEXT_PUBLIC_BILLING_ENABLED: 'false',
      AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    });

    expect(payload.NEXT_PUBLIC_SUPABASE_URL).toBe('https://preview.supabase.co');
    expect(payload.NEXT_PUBLIC_BILLING_ENABLED).toBe('false');
    expect(payload.WEB_PROTECTION_PASSWORD).toBe('shared-password');
    expect(payload).not.toHaveProperty('EDGE_CONFIG');
    expect(payload).not.toHaveProperty('EDGE_CONFIG_ID');
    expect(payload).not.toHaveProperty('VERCEL_API_TOKEN');
    expect(payload).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
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

  test('rejects a profile whose canonical app URL belongs to another environment', () => {
    expect(() =>
      renderWebEnvironment('dev', {
        ...profile('dev'),
        NEXT_PUBLIC_APP_URL: 'https://staging.kortix.com',
      }),
    ).toThrow('NEXT_PUBLIC_APP_URL must target https://dev.kortix.com');
  });

  test('fails closed when a protected profile has no password', () => {
    const environment = profile('dev');
    environment.WEB_PROTECTION_PASSWORD = undefined;
    expect(() => renderWebEnvironment('dev', environment)).toThrow(
      'WEB_PROTECTION_PASSWORD is required',
    );
  });
});
