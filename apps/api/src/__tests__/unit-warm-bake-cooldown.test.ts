import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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
setTestEnv('DAYTONA_API_KEY', 'test-daytona-key');
setTestEnv('DAYTONA_SERVER_URL', 'https://daytona.example.test');
setTestEnv('DAYTONA_TARGET', 'test-target');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

const {
  warmBakeCooldownGate,
  releaseWarmBakeCooldown,
  warmBakeScopeId,
  claimFastWarmBuildProviderSlot,
  releaseFastWarmBuildProviderSlot,
  perProjectColdImageEnabled,
  perProjectWarmReapEnabled,
  perProjectWarmEligible,
  DEFAULT_SANDBOX_SLUG,
} = await import('../snapshots/builder');
const { computeTemplateIdentity, resolveUserDockerfile } = await import('../snapshots/templates');
const { warmBuildSlug, templateSlugFromBuildSlug } = await import('../snapshots/ppwarm-names');
const templatesModule = await import('../snapshots/templates');
type ResolvedTemplate = Awaited<ReturnType<typeof templatesModule.resolveDefaultTemplate>>;
type GitBackedProject = Parameters<typeof computeTemplateIdentity>[0];

const PROJECT = '2d34b9f0-0000-0000-0000-000000000000';
const COOLDOWN = 10 * 60 * 1000;

describe('perProjectColdImageEnabled', () => {
  test.each([
    { legacyWarm: false, fastColdBoot: false, fastConfigured: false, expected: false },
    { legacyWarm: true, fastColdBoot: false, fastConfigured: false, expected: true },
    { legacyWarm: false, fastColdBoot: true, fastConfigured: true, expected: true },
    { legacyWarm: true, fastColdBoot: true, fastConfigured: true, expected: true },
    { legacyWarm: false, fastColdBoot: false, fastConfigured: true, expected: false },
    { legacyWarm: true, fastColdBoot: false, fastConfigured: true, expected: false },
  ])(
    'legacyWarm=$legacyWarm fastColdBoot=$fastColdBoot fastConfigured=$fastConfigured returns $expected',
    ({ legacyWarm, fastColdBoot, fastConfigured, expected }) => {
      expect(
        perProjectColdImageEnabled({
          KORTIX_WARM_SNAPSHOT_ENABLED: legacyWarm,
          KORTIX_FAST_COLD_BOOT_ENABLED: fastColdBoot,
          KORTIX_FAST_COLD_BOOT_CONFIGURED: fastConfigured,
        }),
      ).toBe(expected);
    },
  );

  test('gates both the session lookup and managed-push prebake', () => {
    const source = readFileSync(new URL('../snapshots/builder.ts', import.meta.url), 'utf8');
    const sessionLookup = source.slice(
      source.indexOf('export async function ensureSandboxImage'),
      source.indexOf('// Trust-the-row fast path'),
    );
    const pushPrebake = source.slice(
      source.indexOf('export async function kickProjectWarmPrebake'),
      source.indexOf('async function prebakeForProvider'),
    );

    expect(sessionLookup).toContain('perProjectColdImageEnabled()');
    expect(sessionLookup).toContain('opts.allowProjectImage !== false');
    expect(sessionLookup).toContain('routedProjectImageReadCandidates(');
    expect(sessionLookup).toContain('isProjectImage: true');
    expect(pushPrebake).toContain('if (!perProjectColdImageEnabled()) return;');
    expect(sessionLookup).not.toContain('config.KORTIX_WARM_SNAPSHOT_ENABLED');
    expect(pushPrebake).not.toContain('config.KORTIX_WARM_SNAPSHOT_ENABLED');
  });
});

describe('perProjectWarmReapEnabled', () => {
  test('preserves legacy cleanup, enables scoped FAST cleanup, and honors rollback', () => {
    expect(
      perProjectWarmReapEnabled({
        KORTIX_FAST_COLD_BOOT_CONFIGURED: false,
        KORTIX_FAST_COLD_BOOT_ENABLED: false,
      }),
    ).toBe(true);
    expect(
      perProjectWarmReapEnabled({
        KORTIX_FAST_COLD_BOOT_CONFIGURED: true,
        KORTIX_FAST_COLD_BOOT_ENABLED: true,
      }),
    ).toBe(true);
    expect(
      perProjectWarmReapEnabled({
        KORTIX_FAST_COLD_BOOT_CONFIGURED: true,
        KORTIX_FAST_COLD_BOOT_ENABLED: false,
      }),
    ).toBe(false);
  });

  test('guards the provider-wide listing before any ppwarm target is selected', () => {
    const source = readFileSync(new URL('../snapshots/builder.ts', import.meta.url), 'utf8');
    const reap = source.slice(
      source.indexOf('async function reapOldPerProjectWarm'),
      source.indexOf('\n}', source.indexOf('async function reapOldPerProjectWarm')) + 2,
    );
    expect(reap).toContain('if (!perProjectWarmReapEnabled()) return;');
    expect(reap.indexOf('if (!perProjectWarmReapEnabled()) return;')).toBeLessThan(
      reap.indexOf('provider.listSnapshots()'),
    );
  });
});

const FAKE_PROJECT: GitBackedProject = {
  projectId: PROJECT,
  repoUrl: 'https://example.test/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
};

function makeTemplate(overrides: Partial<ResolvedTemplate>): ResolvedTemplate {
  return {
    templateId: 'tid-1',
    projectId: PROJECT,
    slug: DEFAULT_SANDBOX_SLUG,
    name: DEFAULT_SANDBOX_SLUG,
    isShared: true,
    source: 'platform',
    provider: 'platinum',
    image: null,
    dockerfilePath: null,
    entrypoint: null,
    cpu: 2,
    memoryGb: 4,
    diskGb: 20,
    providerState: 'missing',
    providerSnapshotName: null,
    contentHash: null,
    builtFromCommit: null,
    swapKey: null,
    ...overrides,
  };
}

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

  test('an admission denial releases the kick so the next attempt can retry immediately', () => {
    const registry = new Map<string, number>();
    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);

    releaseWarmBakeCooldown(PROJECT, 'daytona', registry);

    expect(warmBakeCooldownGate(PROJECT, 'daytona', { now: 1, cooldownMs: COOLDOWN, registry })).toBe(true);
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

describe('warmBakeScopeId — per-(project, template) pacing scope', () => {
  test('an omitted slug and the explicit default slug compute the identical key', () => {
    expect(warmBakeScopeId(PROJECT)).toBe(warmBakeScopeId(PROJECT, DEFAULT_SANDBOX_SLUG));
  });

  test('a default-slug caller reproduces the exact pre-change cooldown pacing behavior', () => {
    const registry = new Map<string, number>();
    const scope = warmBakeScopeId(PROJECT);
    expect(warmBakeCooldownGate(scope, 'daytona', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    expect(warmBakeCooldownGate(scope, 'daytona', { now: 1, cooldownMs: COOLDOWN, registry })).toBe(false);
    expect(warmBakeCooldownGate(scope, 'daytona', { now: COOLDOWN, cooldownMs: COOLDOWN, registry })).toBe(true);
  });

  test('a custom template gets an independent pacing scope from the default template', () => {
    expect(warmBakeScopeId(PROJECT, 'custom-tpl')).not.toBe(warmBakeScopeId(PROJECT, DEFAULT_SANDBOX_SLUG));

    const registry = new Map<string, number>();
    const defaultScope = warmBakeScopeId(PROJECT, DEFAULT_SANDBOX_SLUG);
    const customScope = warmBakeScopeId(PROJECT, 'custom-tpl');
    expect(warmBakeCooldownGate(defaultScope, 'platinum', { now: 0, cooldownMs: COOLDOWN, registry })).toBe(true);
    expect(warmBakeCooldownGate(customScope, 'platinum', { now: 1, cooldownMs: COOLDOWN, registry })).toBe(true);
  });

  test('two distinct custom templates get independent pacing scopes from each other', () => {
    expect(warmBakeScopeId(PROJECT, 'tpl-a')).not.toBe(warmBakeScopeId(PROJECT, 'tpl-b'));
  });
});

describe('FAST optional provider build slot', () => {
  test('admits one optional build per provider and releases it for the next project', () => {
    const registry = new Set<string>();
    expect(claimFastWarmBuildProviderSlot('platinum', true, registry)).toBe(true);
    expect(claimFastWarmBuildProviderSlot('platinum', true, registry)).toBe(false);
    expect(claimFastWarmBuildProviderSlot('daytona', true, registry)).toBe(true);
    releaseFastWarmBuildProviderSlot('platinum', true, registry);
    expect(claimFastWarmBuildProviderSlot('platinum', true, registry)).toBe(true);
  });

  test('does not throttle the legacy rollout or required direct builds', () => {
    const registry = new Set(['platinum']);
    expect(claimFastWarmBuildProviderSlot('platinum', false, registry)).toBe(true);
    releaseFastWarmBuildProviderSlot('platinum', false, registry);
    expect(registry).toEqual(new Set(['platinum']));
  });

  test('gates only the optional background path before its direct build call', () => {
    const source = readFileSync(new URL('../snapshots/builder.ts', import.meta.url), 'utf8');
    const background = source.slice(
      source.indexOf('function kickBackgroundWarmBuild'),
      source.indexOf('export function kickProjectWarmPrebake'),
    );
    const direct = source.slice(
      source.indexOf('export async function ensurePerProjectWarmImage'),
      source.indexOf('export function shouldAttemptWarmFromBase'),
    );
    expect(background).toContain('assessFastProjectImageBuildAdmission(');
    expect(background.indexOf('assessFastProjectImageBuildAdmission(')).toBeLessThan(
      background.indexOf('await ensurePerProjectWarmImage('),
    );
    const deniedAdmission = background.slice(
      background.indexOf('if (!admission.allowed)'),
      background.indexOf('const result = await ensurePerProjectWarmImage('),
    );
    expect(deniedAdmission).toContain('releaseWarmBakeCooldown(scopedProjectId, opts.provider)');
    expect(background).toContain('inflightBackgroundBuilds.delete(key)');
    expect(background).toContain('inflightWarmBakesByProject.delete(projectKey)');
    expect(background).toContain('releaseFastWarmBuildProviderSlot(opts.provider, fastEnabled)');
    expect(direct).not.toContain('assessFastProjectImageBuildAdmission(');
    expect(direct).not.toContain('claimFastWarmBuildProviderSlot(');
  });
});

describe('perProjectWarmEligible — read-side warm-image gate', () => {
  test('the shared default template is eligible on every provider', () => {
    const fastOnly = { KORTIX_WARM_SNAPSHOT_ENABLED: false };
    expect(perProjectWarmEligible({ isShared: true }, 'daytona', fastOnly)).toBe(true);
    expect(perProjectWarmEligible({ isShared: true }, 'platinum', fastOnly)).toBe(true);
    expect(perProjectWarmEligible({ isShared: true }, 'e2b', fastOnly)).toBe(true);
  });

  test('the FAST experiment cannot create a custom-template project image', () => {
    expect(
      perProjectWarmEligible(
        { isShared: false },
        'platinum',
        { KORTIX_WARM_SNAPSHOT_ENABLED: false },
      ),
    ).toBe(false);
  });

  test('the legacy WARM flag keeps custom-template project images on an allowlisted provider', () => {
    expect(
      perProjectWarmEligible(
        { isShared: false },
        'platinum',
        { KORTIX_WARM_SNAPSHOT_ENABLED: true },
        (provider) => provider === 'platinum',
      ),
    ).toBe(true);
  });

  test('a custom template is NOT eligible on daytona by default — the 66% Daytona hit-rate path is untouched', () => {
    expect(
      perProjectWarmEligible(
        { isShared: false },
        'daytona',
        { KORTIX_WARM_SNAPSHOT_ENABLED: true },
        (provider) => provider === 'platinum',
      ),
    ).toBe(false);
  });

  test('a custom template is NOT eligible on an unlisted provider', () => {
    expect(
      perProjectWarmEligible(
        { isShared: false },
        'e2b',
        { KORTIX_WARM_SNAPSHOT_ENABLED: true },
        (provider) => provider === 'platinum',
      ),
    ).toBe(false);
  });
});

describe('per-template warm identity — the runtime-matches-template invariant', () => {
  test('resolveUserDockerfile: a custom template resolves ITS OWN Dockerfile content, not the platform default\'s', async () => {
    const shared = makeTemplate({ isShared: true });
    const custom = makeTemplate({
      templateId: 'tid-custom',
      slug: 'custom-tpl',
      name: 'custom-tpl',
      isShared: false,
      image: 'myorg/custom-runtime:latest',
    });

    const sharedResolved = await resolveUserDockerfile(FAKE_PROJECT, shared);
    const customResolved = await resolveUserDockerfile(FAKE_PROJECT, custom);

    expect(customResolved.dockerfile).toBe('FROM myorg/custom-runtime:latest\n');
    expect(customResolved.dockerfile).not.toBe(sharedResolved.dockerfile);
  });

  test('computeTemplateIdentity: a custom template gets a DISTINCT, kortix-tpl-prefixed snapshot identity from the shared default', async () => {
    const shared = makeTemplate({ isShared: true });
    const custom = makeTemplate({
      templateId: 'tid-custom',
      slug: 'custom-tpl',
      name: 'custom-tpl',
      isShared: false,
      image: 'myorg/custom-runtime:latest',
    });

    const sharedIdentity = await computeTemplateIdentity(FAKE_PROJECT, shared);
    const customIdentity = await computeTemplateIdentity(FAKE_PROJECT, custom);

    expect(customIdentity.snapshotName.startsWith('kortix-tpl-')).toBe(true);
    expect(sharedIdentity.snapshotName.startsWith('kortix-default-')).toBe(true);
    expect(customIdentity.snapshotName).not.toBe(sharedIdentity.snapshotName);
    expect(customIdentity.contentHash).not.toBe(sharedIdentity.contentHash);
  });

  test('two custom templates with different images get different identities — the warm bake cannot reuse a stale one', async () => {
    const customA = makeTemplate({ slug: 'tpl-a', isShared: false, image: 'myorg/a:latest' });
    const customB = makeTemplate({ slug: 'tpl-b', isShared: false, image: 'myorg/b:latest' });
    const identityA = await computeTemplateIdentity(FAKE_PROJECT, customA);
    const identityB = await computeTemplateIdentity(FAKE_PROJECT, customB);
    expect(identityA.snapshotName).not.toBe(identityB.snapshotName);
  });
});

describe('warm-bake build-log slug round-trip (Retry build / Fix with agent)', () => {
  test('the default template\'s warm build-log slug round-trips to the default template', () => {
    const recorded = warmBuildSlug(DEFAULT_SANDBOX_SLUG);
    expect(templateSlugFromBuildSlug(recorded)).toBe(DEFAULT_SANDBOX_SLUG);
  });

  test('a CUSTOM template\'s warm build-log slug round-trips to THAT custom template, not the default', () => {
    const customSlug = 'custom-tpl';
    const recorded = warmBuildSlug(customSlug);

    expect(recorded).not.toBe(warmBuildSlug(DEFAULT_SANDBOX_SLUG));
    expect(templateSlugFromBuildSlug(recorded)).toBe(customSlug);
    expect(templateSlugFromBuildSlug(recorded)).not.toBe(DEFAULT_SANDBOX_SLUG);
  });

  test('hardcoding the build-log slug to the default (the pre-fix behavior) would round-trip to the WRONG template for a custom bake', () => {
    const customSlug = 'custom-tpl';
    const preFixRecordedSlug = warmBuildSlug(DEFAULT_SANDBOX_SLUG);
    const resolvedBack = templateSlugFromBuildSlug(preFixRecordedSlug);
    expect(resolvedBack).not.toBe(customSlug);
    expect(resolvedBack).toBe(DEFAULT_SANDBOX_SLUG);
  });
});
