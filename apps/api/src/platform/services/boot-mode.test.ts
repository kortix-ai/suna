import { describe, expect, test } from 'bun:test';

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
setTestEnv('PLATINUM_API_URL', 'https://api.platinum.dev');
setTestEnv('PLATINUM_API_KEY', 'pt_test_key');

const { attemptsLeft, modeAfterFailures, resolveBootMode, sessionBootDecision } = await import('./boot-mode');
const { buildFeatureFlagCatalog, resolveFeatureFlag } = await import('../../feature-flags/registry');
const { requireFeatureFlag } = await import('../../feature-flags/gate');

const on = (flags: Record<string, boolean>) => ({ experimental: flags });
const target = (
  metadata: unknown,
  over: { volumeProvider?: boolean; envVolumeOff?: boolean } = {},
) => ({
  volumeProvider: true,
  volumes: resolveFeatureFlag(metadata, 'volumes'),
  stateless: resolveFeatureFlag(metadata, 'stateless_sessions'),
  envVolumeOff: false,
  ...over,
});

/** The 403 a drive route answers, without a server: `c.json` is all the gate uses. */
const fakeContext = { json: (body: unknown, status: number) => ({ body, status }) } as never;

describe('Volumes and Stateless sessions: project flags', () => {
  test('Volumes off: standard boot, no Files; on: Files, standard boot until Stateless sessions is on', () => {
    for (const metadata of [{}, on({ volumes: false }), on({ drives: true, ephemeral_sandboxes: true })]) {
      expect(resolveBootMode(target(metadata))).toEqual({ mode: 'standard', source: 'volumes_off', standardFallback: true });
      // Derived flags have no project choice of their own.
      expect(resolveFeatureFlag(metadata, 'drives')).toBe(false);
      expect(resolveFeatureFlag(metadata, 'ephemeral_sandboxes')).toBe(false);
      const refused = requireFeatureFlag(fakeContext, metadata, 'drives') as unknown as { status: number; body: { code: string } };
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('feature_disabled');
    }
    // Stateless sessions alone does nothing: it needs Volumes.
    expect(resolveFeatureFlag(on({ stateless_sessions: true }), 'stateless_sessions')).toBe(false);
    expect(resolveBootMode(target(on({ stateless_sessions: true }))).mode).toBe('standard');

    const volumes = on({ volumes: true });
    expect(resolveBootMode(target(volumes))).toEqual({ mode: 'standard', source: 'project', standardFallback: true });
    expect(resolveFeatureFlag(volumes, 'drives')).toBe(true);
    expect(requireFeatureFlag(fakeContext, volumes, 'drives')).toBeNull();

    const stateless = on({ volumes: true, stateless_sessions: true });
    expect(resolveBootMode(target(stateless))).toEqual({ mode: 'volume', source: 'project', standardFallback: true });
    expect(resolveBootMode(target(stateless, { envVolumeOff: true })).mode).toBe('artifacts');
    expect(resolveBootMode(target(stateless, { volumeProvider: false })).mode).toBe('standard');

    // Both are ordinary toggles; the derived ones are not listed.
    const catalog = buildFeatureFlagCatalog(stateless);
    const keys = catalog.map((f) => f.key);
    expect(keys).toContain('volumes');
    expect(keys).toContain('stateless_sessions');
    expect(keys).not.toContain('drives');
    expect(keys).not.toContain('ephemeral_sandboxes');
    for (const f of catalog.filter((f) => f.key === 'volumes' || f.key === 'stateless_sessions')) {
      expect(f.operator_only).toBe(false);
      expect(f.overridden).toBe(true);
    }
  });

  test('a session whose state lives on a volume keeps it after the project turns the flags off', () => {
    for (const metadata of [{}, on({ volumes: true })]) {
      const decision = resolveBootMode(target(metadata));
      expect(sessionBootDecision(decision, true)).toEqual({ mode: 'volume', source: 'session_volume', standardFallback: true });
      expect(sessionBootDecision(decision, false).mode).toBe('standard');
    }
    // And it never steps off that volume after failures.
    expect(modeAfterFailures('volume', { volume: 9 }, true, true)).toBe('volume');
  });

  test('fallback steps down volume → artifacts → image', () => {
    expect(attemptsLeft('volume', { volume: 1 })).toBe(true);
    expect(modeAfterFailures('volume', { volume: 2 }, true)).toBe('artifacts');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 2 }, true)).toBe('standard');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 2 }, false)).toBe('artifacts');
  });
});
