import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const apiRoot = resolve(import.meta.dir, '../..');
const resultPrefix = '__NANGO_CONFIG__';

const baseEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/kortix',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  API_KEY_SECRET: 'test-api-key-secret',
  KORTIX_URL: 'http://localhost:8008',
  ALLOWED_SANDBOX_PROVIDERS: 'local-docker',
  TUNNEL_ENABLED: 'false',
};

type ConfigResult = {
  NANGO_API_KEY: string;
  NANGO_BASE_URL: string;
  NANGO_WEBHOOK_SIGNING_KEY: string;
  NANGO_GITHUB_ACCOUNT_INTEGRATION_ID: string;
  NANGO_GITHUB_MANAGED_INTEGRATION_ID: string;
  GITHUB_CREDENTIAL_RESOLUTION: string;
};

function runConfig(overrides: Record<string, string> = {}) {
  const script = `
    const { config } = await import('./src/config.ts');
    console.log('${resultPrefix}' + JSON.stringify({
      NANGO_API_KEY: config.NANGO_API_KEY,
      NANGO_BASE_URL: config.NANGO_BASE_URL,
      NANGO_WEBHOOK_SIGNING_KEY: config.NANGO_WEBHOOK_SIGNING_KEY,
      NANGO_GITHUB_ACCOUNT_INTEGRATION_ID: config.NANGO_GITHUB_ACCOUNT_INTEGRATION_ID,
      NANGO_GITHUB_MANAGED_INTEGRATION_ID: config.NANGO_GITHUB_MANAGED_INTEGRATION_ID,
      GITHUB_CREDENTIAL_RESOLUTION: config.GITHUB_CREDENTIAL_RESOLUTION,
    }));
  `;
  const result = Bun.spawnSync([process.execPath, '--env-file=/dev/null', '--eval', script], {
    cwd: apiRoot,
    env: { ...baseEnv, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    parse(): ConfigResult {
      const line = this.stdout.split('\n').find((candidate) => candidate.startsWith(resultPrefix));
      if (!line) {
        throw new Error(`Config subprocess did not print a result:\n${this.stderr}`);
      }
      return JSON.parse(line.slice(resultPrefix.length)) as ConfigResult;
    },
  };
}

const enabledNangoEnv = {
  NANGO_API_KEY: 'canonical-api-key',
  NANGO_SECRET_KEY: 'legacy-api-key',
  NANGO_WEBHOOK_SIGNING_KEY: 'webhook-signing-key',
  NANGO_GITHUB_ACCOUNT_INTEGRATION_ID: 'github-app-oauth',
  NANGO_GITHUB_MANAGED_INTEGRATION_ID: 'github-app',
  KORTIX_GIT_PROXY: 'true',
};

describe('Nango configuration', () => {
  test('uses the canonical API key and exposes both GitHub integrations', () => {
    const result = runConfig(enabledNangoEnv);

    expect(result.exitCode).toBe(0);
    expect(result.parse()).toEqual({
      NANGO_API_KEY: 'canonical-api-key',
      NANGO_BASE_URL: 'https://api.nango.dev',
      NANGO_WEBHOOK_SIGNING_KEY: 'webhook-signing-key',
      NANGO_GITHUB_ACCOUNT_INTEGRATION_ID: 'github-app-oauth',
      NANGO_GITHUB_MANAGED_INTEGRATION_ID: 'github-app',
      GITHUB_CREDENTIAL_RESOLUTION: 'nango_only',
    });
  });

  test('uses NANGO_SECRET_KEY only when the canonical key is absent', () => {
    const result = runConfig({
      ...enabledNangoEnv,
      NANGO_API_KEY: '   ',
      NANGO_SECRET_KEY: 'legacy-api-key',
    });

    expect(result.exitCode).toBe(0);
    expect(result.parse().NANGO_API_KEY).toBe('legacy-api-key');
  });

  test('accepts an explicit base URL and nango_only resolver mode', () => {
    const result = runConfig({
      ...enabledNangoEnv,
      NANGO_BASE_URL: 'https://nango.example.test',
      GITHUB_CREDENTIAL_RESOLUTION: 'nango_only',
    });

    expect(result.exitCode).toBe(0);
    expect(result.parse().NANGO_BASE_URL).toBe('https://nango.example.test');
    expect(result.parse().GITHUB_CREDENTIAL_RESOLUTION).toBe('nango_only');
  });

  test('keeps Nango disabled when neither integration is configured', () => {
    const result = runConfig();

    expect(result.exitCode).toBe(0);
    expect(result.parse()).toEqual({
      NANGO_API_KEY: '',
      NANGO_BASE_URL: 'https://api.nango.dev',
      NANGO_WEBHOOK_SIGNING_KEY: '',
      NANGO_GITHUB_ACCOUNT_INTEGRATION_ID: '',
      NANGO_GITHUB_MANAGED_INTEGRATION_ID: '',
      GITHUB_CREDENTIAL_RESOLUTION: 'nango_only',
    });
  });

  test('rejects unresolved dotenvx ciphertext without printing its value', () => {
    const ciphertext = 'encrypted:unresolved-secret-material';
    const result = runConfig({
      ...enabledNangoEnv,
      NANGO_API_KEY: ciphertext,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('NANGO_API_KEY');
    expect(result.stderr).not.toContain(ciphertext);
    expect(result.stderr).not.toContain('OPENSSL');
  });

  test('requires a webhook signing key when a Nango integration is enabled', () => {
    const result = runConfig({
      ...enabledNangoEnv,
      NANGO_WEBHOOK_SIGNING_KEY: '',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('NANGO_WEBHOOK_SIGNING_KEY');
  });

  test('requires the Git proxy when a Nango integration is enabled', () => {
    const result = runConfig({
      ...enabledNangoEnv,
      KORTIX_GIT_PROXY: 'false',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('KORTIX_GIT_PROXY');
  });

  test('rejects unsupported credential resolver modes', () => {
    const result = runConfig({
      ...enabledNangoEnv,
      GITHUB_CREDENTIAL_RESOLUTION: 'legacy_only',
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('GITHUB_CREDENTIAL_RESOLUTION');
  });
});
