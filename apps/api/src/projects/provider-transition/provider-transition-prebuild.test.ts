import { describe, expect, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona,platinum');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { chunkForConcurrency, parsePrebuildConfig } = await import('./provider-transition-prebuild');

describe('prebuild config parsing', () => {
  test('defaults are sane', () => {
    const cfg = parsePrebuildConfig({});
    expect(cfg.targetProvider).toBe('platinum');
    expect(cfg.policy).toBe('recently-active');
    expect(cfg.concurrency).toBe(3);
    expect(cfg.dryRun).toBe(false);
  });

  test('argv overrides env overrides defaults', () => {
    const cfg = parsePrebuildConfig(
      { PREBUILD_POLICY: 'all-active', PREBUILD_CONCURRENCY: '9' },
      ['--policy=selected', '--projects=a,b,c', '--dry-run=true'],
    );
    expect(cfg.policy).toBe('selected');
    expect(cfg.projectIds).toEqual(['a', 'b', 'c']);
    expect(cfg.concurrency).toBe(9);
    expect(cfg.dryRun).toBe(true);
  });

  test('an unknown policy falls back to recently-active', () => {
    expect(parsePrebuildConfig({ PREBUILD_POLICY: 'nonsense' }).policy).toBe('recently-active');
  });
});

describe('concurrency chunking', () => {
  test('splits into bounded batches and never loses an id', () => {
    expect(chunkForConcurrency(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunkForConcurrency([], 3)).toEqual([]);
    expect(chunkForConcurrency(['x'], 0)).toEqual([['x']]);
  });
});
