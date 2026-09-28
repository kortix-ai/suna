import { describe, expect, test } from 'bun:test';

const source = new URL('./config.ts', import.meta.url).pathname;
const base = {
  PATH: process.env.PATH ?? '',
  DATABASE_URL: 'postgres://localhost/test',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role',
  API_KEY_SECRET: 'synthetic-api-secret',
  TUNNEL_ENABLED: 'false',
  KORTIX_URL: 'http://localhost:8008',
  ALLOWED_SANDBOX_PROVIDERS: 'e2b',
};

function load(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = Bun.spawnSync([
    process.execPath,
    '-e',
    `const { config } = await import(${JSON.stringify(source)}); console.log('CONFIG_KEYS=' + JSON.stringify(Object.keys(config)));`,
  ], { env, cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString().replaceAll(/\x1b\[[0-9;]*m/g, ''),
  };
}

describe('config module startup characterization', () => {
  test.each(['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'API_KEY_SECRET'])(
    'missing %s prevents startup', (key) => {
      const result = load({ [key]: undefined });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Environment validation FAILED');
      expect(result.stderr).toContain(key);
    },
  );

  test('invalid Supabase URL prevents startup', () => {
    const result = load({ SUPABASE_URL: 'not-a-url' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('SUPABASE_URL must be a valid HTTP(S) URL');
  });

  test('billing requires its dependent settings', () => {
    const result = load({ KORTIX_BILLING_INTERNAL_ENABLED: 'true', KORTIX_URL: undefined });
    expect(result.exitCode).toBe(1);
    for (const key of ['E2B_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'KORTIX_URL']) {
      expect(result.stderr).toContain(key);
    }
  });

  test('config releases with a custom endpoint require credentials', () => {
    const result = load({
      CONFIG_RELEASES_ENABLED: 'true',
      KORTIX_CONFIG_ARCHIVE_S3_BUCKET: 'synthetic-bucket',
      KORTIX_CONFIG_ARCHIVE_S3_ENDPOINT: 'http://localhost:9000',
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('KORTIX_CONFIG_ARCHIVE_S3_ACCESS_KEY_ID');
  });

  test('exported config retains representative keys across modules', () => {
    const result = load();
    expect(result.exitCode).toBe(0);
    const keys = JSON.parse(result.stdout.split('CONFIG_KEYS=')[1] ?? '[]') as string[];
    for (const key of [
      'DATABASE_URL', 'SUPABASE_URL', 'API_KEY_SECRET', 'KORTIX_URL',
      'KORTIX_BILLING_INTERNAL_ENABLED', 'CONFIG_RELEASES_ENABLED',
      'KORTIX_CONFIG_ARCHIVE_S3_BUCKET', 'LLM_GATEWAY_FALLBACK_POLICIES',
      'ALLOWED_SANDBOX_PROVIDERS', 'INTERNAL_SERVICE_KEY', 'FRONTEND_URL',
    ]) {
      expect(keys).toContain(key);
    }
  });
});
