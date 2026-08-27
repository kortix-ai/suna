import { afterEach, describe, expect, test } from 'bun:test';

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
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'platinum,daytona');
setTestEnv('KORTIX_URL', 'https://api.example.test');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');
setTestEnv('PLATINUM_API_URL', 'https://platinum.test');
setTestEnv('PLATINUM_API_KEY', 'pt_live_testkey');
setTestEnv('DAYTONA_API_KEY', 'dt_test');

const {
  decideSessionBoot,
  fastColdBootEnabled,
  sessionBootByTemplateIdEnabled,
} = await import('./session-sandbox');

const pinned = {
  activeProvider: 'platinum',
  activeExternalTemplateId: 'tpl_pinned',
  activeSnapshotName: 'snap-project-current',
};

describe('FIX-A decideSessionBoot — pinned-id boot gating', () => {
  test('boots by the pinned id when provider and image names match', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-project-current',
      }),
    ).toEqual({ bootByTemplateId: 'tpl_pinned' });
  });

  test('a custom template never boots the pinned project-default template id', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: false,
      }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('boots by the activated id when the resolved image name matches the activation', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-project-current',
      }),
    ).toEqual({ bootByTemplateId: 'tpl_pinned' });
  });

  test('name-boots when the resolved image name differs from the activated image', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-project-newer',
      }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('name-boots when the activation records no image name', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: { ...pinned, activeSnapshotName: null },
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-project-current',
      }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('never boots an activated id whose recorded image name is not the resolved one', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-standard-base',
      }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('a named activation requires the resolved image name', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
      }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('a legacy activation without recoverable image metadata fails closed to name boot', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: { ...pinned, activeSnapshotName: null },
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-standard-base',
      }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('rollback: a leftover Platinum id pin does NOT id-boot a Daytona session (name-boot)', () => {
    // Rolled back to Daytona: the session runs on Daytona, which has no id-boot,
    // so a stale Platinum id in the pin can never brick boot.
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: {
          activeProvider: 'daytona',
          activeExternalTemplateId: 'tpl_platinum_leftover',
          activeSnapshotName: null,
        },
        providerName: 'daytona',
        providerSupportsIdBoot: false,
      }),
    ).toEqual({ bootByTemplateId: null });
    // And a session whose provider differs from the pin's provider never id-boots.
    expect(
      decideSessionBoot({ killSwitchOn: true, routing: pinned, providerName: 'daytona', providerSupportsIdBoot: true }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('kill-switch OFF forces name-only boot even with a matching pin', () => {
    expect(
      decideSessionBoot({ killSwitchOn: false, routing: pinned, providerName: 'platinum', providerSupportsIdBoot: true }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('no pin (null id, or no routing) → name boot', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: {
          activeProvider: 'platinum',
          activeExternalTemplateId: null,
          activeSnapshotName: null,
        },
        providerName: 'platinum',
        providerSupportsIdBoot: true,
      }),
    ).toEqual({ bootByTemplateId: null });
    expect(
      decideSessionBoot({ killSwitchOn: true, routing: null, providerName: 'platinum', providerSupportsIdBoot: true }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('a provider without createFromExternalId → name boot', () => {
    expect(
      decideSessionBoot({ killSwitchOn: true, routing: pinned, providerName: 'platinum', providerSupportsIdBoot: false }),
    ).toEqual({ bootByTemplateId: null });
  });

  test('disabledForSession prevents an exact id boot even on a full name match', () => {
    expect(
      decideSessionBoot({
        killSwitchOn: true,
        routing: pinned,
        providerName: 'platinum',
        providerSupportsIdBoot: true,
        imageIsDefault: true,
        imageSnapshotName: 'snap-project-current',
        disabledForSession: true,
      }),
    ).toEqual({ bootByTemplateId: null });
  });
});

describe('FIX-A kill-switch — KORTIX_SESSION_BOOT_BY_TEMPLATE_ID', () => {
  const saved = process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID;
    else process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID = saved;
  });

  test('default (unset) is ON', () => {
    delete process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID;
    expect(sessionBootByTemplateIdEnabled()).toBe(true);
  });
  test.each(['0', 'off', 'false', 'no', 'OFF'])('%p disables id-boot', (v) => {
    process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID = v;
    expect(sessionBootByTemplateIdEnabled()).toBe(false);
  });
  test.each(['1', 'on', 'true'])('%p keeps id-boot ON', (v) => {
    process.env.KORTIX_SESSION_BOOT_BY_TEMPLATE_ID = v;
    expect(sessionBootByTemplateIdEnabled()).toBe(true);
  });
});

describe('fast cold boot kill-switch', () => {
  const saved = process.env.KORTIX_FAST_COLD_BOOT_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.KORTIX_FAST_COLD_BOOT_ENABLED;
    else process.env.KORTIX_FAST_COLD_BOOT_ENABLED = saved;
  });

  test('defaults OFF', () => {
    delete process.env.KORTIX_FAST_COLD_BOOT_ENABLED;
    expect(fastColdBootEnabled()).toBe(false);
  });

  test.each(['1', 'on', 'true', 'yes', 'TRUE'])('%p enables the experiment', (value) => {
    process.env.KORTIX_FAST_COLD_BOOT_ENABLED = value;
    expect(fastColdBootEnabled()).toBe(true);
  });

  test.each(['0', 'off', 'false', 'no', 'unexpected'])('%p disables the experiment', (value) => {
    process.env.KORTIX_FAST_COLD_BOOT_ENABLED = value;
    expect(fastColdBootEnabled()).toBe(false);
  });

});
