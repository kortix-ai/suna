import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) process.env[name] = value;
}
setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum');
setTestEnv('KORTIX_URL', 'https://api.example.com');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');
setTestEnv('PLATINUM_API_URL', 'https://api.platinum.dev');
setTestEnv('PLATINUM_API_KEY', 'pt_test_key');

const { resolveSessionSandboxRegion } = await import('./sandbox-region');
const { platinumUsRegion } = await import('../../shared/platinum-region');
const { resolveFeatureFlag, buildFeatureFlagCatalog } = await import('../../feature-flags/registry');
const { config } = await import('../../config');

const ON = { experimental: { us_region: true } };
const OFF = { experimental: { us_region: false } };
const regionEnv = ['KORTIX_PLATINUM_US_REGION', 'AWS_REGION', 'DATABASE_URL', 'KORTIX_PROJECT_SNAPSHOT_S3_REGION', 'KORTIX_CONFIG_ARCHIVE_S3_REGION'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => { saved = Object.fromEntries(regionEnv.map((key) => [key, process.env[key]])); });
afterEach(() => {
  config.KORTIX_PLATINUM_US_REGION_DEFAULT_ENABLED = false;
  for (const key of regionEnv) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('us_region', () => {
  test('flag on chooses configured compute placement independently of API, database and archive regions', () => {
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    process.env.AWS_REGION = 'us-west-2';
    process.env.DATABASE_URL = 'postgres://u:p@db.cluster-test.us-west-2.rds.amazonaws.com/db';
    process.env.KORTIX_PROJECT_SNAPSHOT_S3_REGION = 'us-west-2';
    process.env.KORTIX_CONFIG_ARCHIVE_S3_REGION = 'us-west-2';
    expect(resolveSessionSandboxRegion(ON)).toBe('us-east');
    for (const key of ['AWS_REGION', 'DATABASE_URL', 'KORTIX_PROJECT_SNAPSHOT_S3_REGION', 'KORTIX_CONFIG_ARCHIVE_S3_REGION']) {
      delete process.env[key];
      expect(resolveSessionSandboxRegion(ON)).toBe('us-east');
    }
  });

  test('flag off, or never chosen (default off) ⇒ the home region (undefined)', () => {
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    expect(resolveSessionSandboxRegion(OFF)).toBeUndefined();
    expect(resolveSessionSandboxRegion({})).toBeUndefined();
    expect(resolveSessionSandboxRegion(null)).toBeUndefined();
  });

  test('operator default on ⇒ a project that never chose gets the US region; an explicit off still wins', () => {
    process.env.KORTIX_PLATINUM_US_REGION = 'us-east';
    config.KORTIX_PLATINUM_US_REGION_DEFAULT_ENABLED = true;
    expect(resolveSessionSandboxRegion({})).toBe('us-east');
    expect(resolveSessionSandboxRegion(null)).toBe('us-east');
    expect(resolveSessionSandboxRegion(ON)).toBe('us-east');
    expect(resolveSessionSandboxRegion(OFF)).toBeUndefined();
    const entry = buildFeatureFlagCatalog({}).find((f: { key: string }) => f.key === 'us_region');
    expect(entry).toMatchObject({ available: true, enabled: true, overridden: false });
  });

  test('operator default on without a region ⇒ the flag stays unavailable and every project gets the home region', () => {
    delete process.env.KORTIX_PLATINUM_US_REGION;
    config.KORTIX_PLATINUM_US_REGION_DEFAULT_ENABLED = true;
    expect(resolveFeatureFlag({}, 'us_region')).toBe(false);
    expect(resolveSessionSandboxRegion({})).toBeUndefined();
  });

  test('the operator default is off when the environment does not set it', () => {
    expect(process.env.KORTIX_PLATINUM_US_REGION_DEFAULT_ENABLED).toBeUndefined();
    expect(config.KORTIX_PLATINUM_US_REGION_DEFAULT_ENABLED).toBe(false);
  });

  test('environment unset ⇒ the flag is unavailable: not enabled, not listed, and a project that switched it on still gets the home region', () => {
    delete process.env.KORTIX_PLATINUM_US_REGION;
    expect(resolveFeatureFlag(ON, 'us_region')).toBe(false);
    expect(resolveSessionSandboxRegion(ON)).toBeUndefined();
    const entry = buildFeatureFlagCatalog({}).find((f: { key: string }) => f.key === 'us_region');
    expect(entry?.available ?? false).toBe(false);
  });

  test('a malformed region value is ignored rather than sent to Platinum', () => {
    for (const bad of ['US-EAST', 'us east', 'us-east; rm -rf', 'x', ' ']) {
      process.env.KORTIX_PLATINUM_US_REGION = bad;
      expect(platinumUsRegion()).toBeNull();
      expect(resolveSessionSandboxRegion(ON)).toBeUndefined();
    }
    process.env.KORTIX_PLATINUM_US_REGION = '  us-east  ';
    expect(platinumUsRegion()).toBe('us-east');
  });
});
