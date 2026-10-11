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

const {
  attemptsLeft,
  modeAfterFailures,
  parseBootModePolicy,
  resolveBootMode,
  resolveVolumes,
  rolloutBucket,
  sessionBootDecision,
} = await import('./boot-mode');
const { __setBootModePolicyForTests } = await import('./boot-mode-setting');
const { buildFeatureFlagCatalog, resolveFeatureFlag } = await import('../../feature-flags/registry');
const { requireFeatureFlag } = await import('../../feature-flags/gate');

const ORG_ON = '11111111-1111-4111-8111-111111111111';
const ORG_OFF = '22222222-2222-4222-8222-222222222222';
const ORG_OTHER = '33333333-3333-4333-8333-333333333333';

const target = (accountId: string, over: { volumeProvider?: boolean; envVolumeOff?: boolean } = {}) => ({
  accountId,
  volumeProvider: true,
  envVolumeOff: false,
  ...over,
});

/** The 403 a drive route answers, without a server: `c.json` is all the gate uses. */
const fakeContext = { json: (body: unknown, status: number) => ({ body, status }) } as never;

describe('Volumes: one switch per organization', () => {
  test('off: standard boot, no drives, drive routes refuse; on: volume boot and drives', () => {
    const stored = { volumes: { enabled: false, orgs: { [ORG_ON]: true, [ORG_OFF]: false } } };
    __setBootModePolicyForTests(stored);
    const policy = parseBootModePolicy(stored, false);

    // Off (by default and explicitly): the old product.
    for (const org of [ORG_OFF, ORG_OTHER]) {
      expect(resolveBootMode(policy, target(org))).toEqual({ mode: 'standard', source: 'volumes_off', standardFallback: true });
      // A project's own override no longer turns anything on.
      expect(resolveFeatureFlag({ experimental: { drives: true, ephemeral_sandboxes: true } }, 'drives', org)).toBe(false);
      expect(resolveFeatureFlag({}, 'ephemeral_sandboxes', org)).toBe(false);
      const refused = requireFeatureFlag(fakeContext, {}, 'drives', org) as unknown as { status: number; body: { code: string } };
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('feature_disabled');
    }
    // Without the organization the derived flags fail closed.
    expect(resolveFeatureFlag({}, 'drives')).toBe(false);

    // On: Files over the drive, and sessions boot on a volume with fallback.
    expect(resolveBootMode(policy, target(ORG_ON))).toEqual({ mode: 'volume', source: 'default', standardFallback: true });
    expect(resolveFeatureFlag({}, 'drives', ORG_ON)).toBe(true);
    expect(resolveFeatureFlag({}, 'ephemeral_sandboxes', ORG_ON)).toBe(true);
    expect(requireFeatureFlag(fakeContext, {}, 'drives', ORG_ON)).toBeNull();
    // Off the volume provider, nothing to choose.
    expect(resolveBootMode(policy, target(ORG_ON, { volumeProvider: false })).mode).toBe('standard');

    // Neither flag is a toggle any more.
    const keys = buildFeatureFlagCatalog({}, ORG_ON).map((f) => f.key);
    expect(keys).not.toContain('drives');
    expect(keys).not.toContain('ephemeral_sandboxes');
  });

  test('an existing session volume is still mounted after the organization turns Volumes off', () => {
    const policy = parseBootModePolicy({ volumes: { orgs: { [ORG_OFF]: false } } }, false);
    const decision = resolveBootMode(policy, target(ORG_OFF));
    expect(sessionBootDecision(decision, true)).toEqual({ mode: 'volume', source: 'session_volume', standardFallback: true });
    expect(sessionBootDecision(decision, false).mode).toBe('standard');
    // And it never steps off that volume after failures.
    expect(modeAfterFailures('volume', { volume: 9 }, policy, true, true)).toBe('volume');
  });

  test('targeting: org over global over rollout; per-org mode rule; kill switch; env override', () => {
    const policy = parseBootModePolicy(
      {
        volumes: { enabled: true, orgs: { [ORG_OFF]: false } },
        default: { mode: 'volume' },
        orgs: { [ORG_ON]: { mode: 'artifacts', standardFallback: false } },
      },
      false,
    );
    expect(resolveVolumes(policy, ORG_OFF)).toEqual({ enabled: false, source: 'off' });
    expect(resolveVolumes(policy, ORG_OTHER)).toEqual({ enabled: true, source: 'global' });
    expect(resolveBootMode(policy, target(ORG_ON))).toEqual({ mode: 'artifacts', source: 'org', standardFallback: false });
    expect(resolveBootMode({ ...policy, killSwitch: true }, target(ORG_OTHER)).source).toBe('kill_switch');
    expect(resolveBootMode(policy, target(ORG_OTHER, { envVolumeOff: true })).mode).toBe('artifacts');

    // Rollout: stable per org, partitions by percent while the global switch is off.
    const bucket = rolloutBucket(ORG_OTHER);
    expect(rolloutBucket(ORG_OTHER.toUpperCase())).toBe(bucket);
    const at = (percent: number) => resolveVolumes({ volumes: { enabled: false, percent, orgs: {} } }, ORG_OTHER).source;
    expect(at(bucket)).toBe('off');
    expect(at(bucket + 1)).toBe('rollout');
  });

  test('fallback steps down volume → artifacts → image, per rule', () => {
    const policy = parseBootModePolicy({ fallback: { volumeAttempts: 2, artifactsAttempts: 1 } }, true);
    expect(policy.volumes.enabled).toBe(false);
    expect(policy.default.mode).toBe('volume');
    expect(attemptsLeft('volume', { volume: 1 }, policy)).toBe(true);
    expect(modeAfterFailures('volume', { volume: 2 }, policy, true)).toBe('artifacts');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 1 }, policy, true)).toBe('standard');
    expect(modeAfterFailures('volume', { volume: 2, artifacts: 1 }, policy, false)).toBe('artifacts');
  });
});
