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

const { attemptsLeft, modeAfterFailures, parseBootModePolicy, resolveBootMode, sessionBootDecision } = await import('./boot-mode');
const { buildFeatureFlagCatalog, isOperatorOnlyFeatureFlag, resolveFeatureFlag } = await import('../../feature-flags/registry');
const { requireFeatureFlag } = await import('../../feature-flags/gate');

const target = (over: { volumes?: boolean; stateless?: boolean; volumeProvider?: boolean; envVolumeOff?: boolean } = {}) => ({
  volumes: true,
  stateless: false,
  volumeProvider: true,
  envVolumeOff: false,
  ...over,
});

const project = (flags: Record<string, boolean>) => ({ experimental: flags });

/** The 403 a drive route answers, without a server: `c.json` is all the gate uses. */
const fakeContext = { json: (body: unknown, status: number) => ({ body, status }) } as never;

describe('Volumes and Stateless sessions: per-project flags', () => {
  test('off by default: no drives, drive list refuses with project wording', () => {
    expect(resolveFeatureFlag({}, 'volumes')).toBe(false);
    expect(resolveFeatureFlag({}, 'drives')).toBe(false);
    expect(resolveFeatureFlag({}, 'ephemeral_sandboxes')).toBe(false);
    // A project override of a derived flag turns nothing on.
    expect(resolveFeatureFlag(project({ drives: true, ephemeral_sandboxes: true }), 'drives')).toBe(false);
    const refused = requireFeatureFlag(fakeContext, {}, 'drives') as unknown as { status: number; body: { code: string; error: string } };
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('feature_disabled');
    expect(refused.body.error).toBe('Files is not enabled for this project. Turn on Volumes in Settings → Feature flags.');
  });

  test("the project's own Volumes switch turns on Files and session volumes; Stateless needs Volumes", () => {
    const on = project({ volumes: true });
    expect(resolveFeatureFlag(on, 'drives')).toBe(true);
    expect(resolveFeatureFlag(on, 'ephemeral_sandboxes')).toBe(true);
    expect(requireFeatureFlag(fakeContext, on, 'drives')).toBeNull();
    expect(resolveFeatureFlag(project({ stateless_sessions: true }), 'stateless_sessions')).toBe(false);
    expect(resolveFeatureFlag(project({ volumes: true, stateless_sessions: true }), 'stateless_sessions')).toBe(true);
  });

  test('the catalog lists both as ordinary project toggles, never organization or operator-only', () => {
    const catalog = buildFeatureFlagCatalog(project({ volumes: true }));
    const volumes = catalog.find((f) => f.key === 'volumes')!;
    const stateless = catalog.find((f) => f.key === 'stateless_sessions')!;
    expect(volumes).toMatchObject({ enabled: true, overridden: true, operator_only: false, scope: 'project' });
    expect(stateless).toMatchObject({ enabled: false, overridden: false, operator_only: false, scope: 'project' });
    expect(isOperatorOnlyFeatureFlag('volumes')).toBe(false);
    expect(isOperatorOnlyFeatureFlag('stateless_sessions')).toBe(false);
    expect(catalog.every((f) => f.scope === 'project')).toBe(true);
    // Derived flags are never toggles.
    const keys = catalog.map((f) => f.key);
    expect(keys).not.toContain('drives');
    expect(keys).not.toContain('ephemeral_sandboxes');
  });
});

describe('boot mode', () => {
  test('Volumes off: standard boot; on: the default rule; Stateless: volume', () => {
    const policy = parseBootModePolicy({}, false);
    expect(resolveBootMode(policy, target({ volumes: false }))).toEqual({ mode: 'standard', source: 'volumes_off', standardFallback: true });
    expect(resolveBootMode(policy, target())).toEqual({ mode: 'standard', source: 'default', standardFallback: true });
    expect(resolveBootMode(policy, target({ stateless: true }))).toEqual({ mode: 'volume', source: 'project', standardFallback: true });
    // Off the volume provider, nothing to choose.
    expect(resolveBootMode(policy, target({ stateless: true, volumeProvider: false })).mode).toBe('standard');
  });

  test('a stored per-organization policy (before 2026-10-13) no longer decides anything', () => {
    const ORG = '11111111-1111-4111-8111-111111111111';
    const legacy = parseBootModePolicy(
      { volumes: { enabled: true, percent: 100, orgs: { [ORG]: true } }, orgs: { [ORG]: { mode: 'volume' } } },
      false,
    );
    expect(legacy).not.toHaveProperty('volumes');
    expect(legacy).not.toHaveProperty('orgs');
    expect(resolveBootMode(legacy, target({ volumes: false })).source).toBe('volumes_off');
    expect(resolveBootMode(legacy, target()).mode).toBe('standard');
  });

  test('default rule, kill switch, env override', () => {
    const policy = parseBootModePolicy({ default: { mode: 'artifacts', standardFallback: false } }, false);
    expect(resolveBootMode(policy, target())).toEqual({ mode: 'artifacts', source: 'default', standardFallback: false });
    expect(resolveBootMode({ ...policy, killSwitch: true }, target({ stateless: true })).source).toBe('kill_switch');
    // A stored `default: volume` never makes a project stateless.
    expect(resolveBootMode(parseBootModePolicy({ default: { mode: 'volume' } }, false), target()).mode).toBe('standard');
    expect(resolveBootMode(policy, target({ stateless: true, envVolumeOff: true }))).toEqual({
      mode: 'artifacts',
      source: 'project',
      standardFallback: false,
      capped: 'env_volume_off',
    });
  });

  test('an existing session volume is still mounted after the project turns Volumes off', () => {
    const policy = parseBootModePolicy({}, false);
    const decision = resolveBootMode(policy, target({ volumes: false }));
    expect(sessionBootDecision(decision, true)).toEqual({ mode: 'volume', source: 'session_volume', standardFallback: true });
    expect(sessionBootDecision(decision, false).mode).toBe('standard');
    // And it never steps off that volume after failures.
    expect(modeAfterFailures('volume', { volume: 9 }, policy, true, true)).toBe('volume');
  });

  test('fallback steps down volume → artifacts → image, per rule', () => {
    const policy = parseBootModePolicy({ fallback: { volumeAttempts: 2, artifactsAttempts: 1 } }, true);
    expect(policy.default.mode).toBe('standard');
    expect(attemptsLeft('volume', { volume: 1 }, policy)).toBe(true);
    expect(modeAfterFailures('volume', { volume: 2 }, policy, true)).toBe('artifacts');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 1 }, policy, true)).toBe('standard');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 1 }, policy, false)).toBe('artifacts');
  });
});
