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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona');
setTestEnv('DAYTONA_API_KEY', 'test-daytona-key');
setTestEnv('DAYTONA_SERVER_URL', 'https://daytona.example.test');
setTestEnv('DAYTONA_TARGET', 'test-target');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

const { warmBakeCooldownGate } = await import('../snapshots/builder');

const PROJECT = '2d34b9f0-0000-0000-0000-000000000000';
const COOLDOWN = 10 * 60 * 1000;

describe('warmBakeCooldownGate — per-(project, provider) bake pacing', () => {
  test('first kick passes and starts the cooldown', () => {
    const registry = new Map<string, number>();
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    expect(registry.get(`${PROJECT}:daytona`)).toBe(0);
  });

  test('kicks inside the cooldown are rejected — a push every few minutes bakes once per window', () => {
    const registry = new Map<string, number>();
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    for (const minute of [1, 4, 7, 9]) {
      expect(
        warmBakeCooldownGate(PROJECT, 'daytona', { now: minute * 60_000, cooldownMs: COOLDOWN, registry }),
      ).toBe(false);
    }
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: COOLDOWN, cooldownMs: COOLDOWN, registry })).toBe(true);
  });

  test('a rejected kick does not extend the cooldown window', () => {
    const registry = new Map<string, number>();
    warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry });
    warmBakeCooldownGate(PROJECT, 'daytona', { now: COOLDOWN - 1, cooldownMs: COOLDOWN, registry });
    expect(registry.get(`${PROJECT}:daytona`)).toBe(0);
  });

  test('providers cool down independently — parity fan-out is paced per provider, not globally', () => {
    const registry = new Map<string, number>();
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    expect(warmBakeCooldownGate(PROJECT, 'platinum', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 1, cooldownMs: COOLDOWN, registry })).toBe(false);
    expect(warmBakeCooldownGate(PROJECT, 'platinum', { now: 1, cooldownMs: COOLDOWN, registry })).toBe(false);
  });

  test('projects cool down independently', () => {
    const registry = new Map<string, number>();
    const other = 'adfd91b6-0000-0000-0000-000000000000';
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    expect(warmBakeCooldownGate(other, 'daytona', { now: 1, cooldownMs: COOLDOWN, registry })).toBe(true);
  });

  test('a zero cooldown disables pacing (escape hatch for tests/ops)', () => {
    const registry = new Map<string, number>();
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: 0, registry })).toBe(true);
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: 0, registry })).toBe(true);
  });
});
