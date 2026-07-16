import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CATEGORY_ORDER,
  groupSecretsByCategory,
  isUpdaterManagedKey,
  maskSecretValue,
  ROTATABLE_GENERATED_KEYS,
  servicesForKeys,
} from '../secrets-registry.ts';
import {
  gitProviderConfigured,
  missingRequiredSecrets,
  sandboxProviderConfigured,
  shouldPullImages,
} from '../../commands/self-host.ts';

// ── Pure registry helpers (no filesystem/process access) ────────────────────

describe('secrets-registry pure helpers', () => {
  test('groupSecretsByCategory returns every category in CATEGORY_ORDER with correctly-flagged rows', () => {
    const groups = groupSecretsByCategory({
      DAYTONA_API_KEY: 'dtn_abcdefghijklmnop',
      OPENROUTER_API_KEY: '',
    });

    expect(groups.map((g) => g.category)).toEqual(CATEGORY_ORDER);

    const sandboxGroup = groups.find((g) => g.category === 'sandbox')!;
    const daytona = sandboxGroup.rows.find((r) => r.key === 'DAYTONA_API_KEY')!;
    expect(daytona.configured).toBe(true);
    expect(daytona.required).toBe(true);
    expect(daytona.kind).toBe('operator');
    expect(daytona.masked).toBe('dtn…mnop');

    const llmGroup = groups.find((g) => g.category === 'llm')!;
    const openrouter = llmGroup.rows.find((r) => r.key === 'OPENROUTER_API_KEY')!;
    expect(openrouter.configured).toBe(false);
    expect(openrouter.masked).toBe('');

    const internalGroup = groups.find((g) => g.category === 'internal_tokens')!;
    const gatewayToken = internalGroup.rows.find((r) => r.key === 'GATEWAY_INTERNAL_TOKEN')!;
    expect(gatewayToken.kind).toBe('generated');
    expect(gatewayToken.rotatable).toBe(true);
    expect(gatewayToken.updaterManaged).toBe(false);
  });

  test('maskSecretValue: empty stays empty, short values become a fixed-width mask, long values keep only the edges', () => {
    expect(maskSecretValue('')).toBe('');
    expect(maskSecretValue('ab')).toBe('•'.repeat(4)); // clamps up to a 4-char floor
    expect(maskSecretValue('1234567890')).toBe('•'.repeat(8)); // len === 10, boundary of the "short" branch
    expect(maskSecretValue('12345678901')).toBe('123…8901'); // len === 11, first long value
    expect(maskSecretValue('sk-or-v1-abcdef0123456789')).toBe('sk-…6789');
  });

  test('servicesForKeys dedupes and sorts across overlapping service sets, and falls back to kortix-api for unknown keys', () => {
    // POSTGRES_PASSWORD and SUPABASE_JWT_SECRET both configure supabase-db and
    // kortix-api among others — the union must be deduped, not concatenated.
    const services = servicesForKeys(['POSTGRES_PASSWORD', 'SUPABASE_JWT_SECRET']);
    expect(services).toEqual([...new Set(services)]); // no duplicates
    expect(services).toEqual([...services].sort()); // sorted
    expect(services).toContain('supabase-db');
    expect(services).toContain('kortix-api');

    expect(servicesForKeys(['NOT_A_REAL_KEY'])).toEqual(['kortix-api']);
    expect(servicesForKeys([])).toEqual([]);
  });

  test('ROTATABLE_GENERATED_KEYS excludes the internal Supabase-infra encryption keys', () => {
    for (const infraKey of ['SECRET_KEY_BASE', 'REALTIME_DB_ENC_KEY', 'VAULT_ENC_KEY', 'PG_META_CRYPTO_KEY']) {
      expect(ROTATABLE_GENERATED_KEYS).not.toContain(infraKey);
    }
    expect(ROTATABLE_GENERATED_KEYS).toContain('POSTGRES_PASSWORD');
    expect(ROTATABLE_GENERATED_KEYS).toContain('SUPABASE_JWT_SECRET');
  });

  test('isUpdaterManagedKey only flags the updater/image-tag keys, not ordinary secrets', () => {
    expect(isUpdaterManagedKey('KORTIX_VERSION')).toBe(true);
    expect(isUpdaterManagedKey('API_IMAGE')).toBe(true);
    // The instance dir's absolute host path — recomputed on every render (see
    // normalizeFullSupabaseEnv in commands/self-host.ts) exactly like
    // KORTIX_APP_REPLICAS, so hand-setting it is refused for the same reason.
    expect(isUpdaterManagedKey('KORTIX_INSTANCE_DIR')).toBe(true);
    expect(isUpdaterManagedKey('OPENROUTER_API_KEY')).toBe(false);
    expect(isUpdaterManagedKey('DAYTONA_API_KEY')).toBe(false);
  });
});

// ── missingRequiredSecrets / composite provider checks ───────────────────────

/** A .env-shaped object with every required secret already generated (as
 *  `init` would leave them) but every operator-supplied one still blank —
 *  i.e. exactly the state right after a non-interactive `init`. */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    DAYTONA_API_KEY: '',
    MANAGED_GIT_PROVIDER: 'github',
    MANAGED_GIT_GITHUB_OWNER: '',
    MANAGED_GIT_GITHUB_TOKEN: '',
    MANAGED_GIT_GITHUB_INSTALL_ID: '',
    KORTIX_GITHUB_APP_ID: '',
    KORTIX_GITHUB_APP_PRIVATE_KEY: '',
    OPENROUTER_API_KEY: '',
    POSTGRES_PASSWORD: 'p'.repeat(32),
    SUPABASE_JWT_SECRET: 'j'.repeat(64),
    SUPABASE_ANON_KEY: 'anon.jwt.token',
    SUPABASE_SERVICE_ROLE_KEY: 'service.jwt.token',
    DASHBOARD_USERNAME: 'kortix',
    DASHBOARD_PASSWORD: 'd'.repeat(24),
    GATEWAY_INTERNAL_TOKEN: 'g'.repeat(32),
    INTERNAL_SERVICE_KEY: 'i'.repeat(32),
    API_KEY_SECRET: 'a'.repeat(32),
    TUNNEL_SIGNING_SECRET: 't'.repeat(32),
    // Internal Supabase-infra encryption keys — required:true in SECRET_DEFS
    // (see secrets-registry.ts) purely so `env ls` masks them; always
    // generated by defaultEnv() before `init` ever writes a .env, same as
    // the other generated secrets above.
    SECRET_KEY_BASE: 'k'.repeat(48),
    REALTIME_DB_ENC_KEY: 'r'.repeat(8),
    VAULT_ENC_KEY: 'v'.repeat(16),
    PG_META_CRYPTO_KEY: 'm'.repeat(24),
    LOGFLARE_PUBLIC_ACCESS_TOKEN: 'l'.repeat(24),
    LOGFLARE_PRIVATE_ACCESS_TOKEN: 'l'.repeat(24),
    ...overrides,
  };
}

describe('missingRequiredSecrets', () => {
  // The CLI's init-time gate is deliberately narrow: ONLY the agent sandbox
  // runtime (Daytona) is required — the one credential with no in-app
  // settings surface. Managed git (GitHub, Settings → Git) and the LLM key
  // (BYOK via the model picker) are both configured in the dashboard after
  // `start` and no longer block init/start — see missingRequiredSecrets() in
  // commands/self-host.ts. gitProviderConfigured() itself is unchanged (still
  // a useful composite "is git set up" check for the dashboard-pointer note
  // in renderIntegrationSummary), it just no longer feeds this gate.
  test('a fresh (just-initialized, nothing configured) env reports only the sandbox runtime', () => {
    const missing = missingRequiredSecrets(baseEnv());
    const labels = missing.map((m) => m.label).join(' | ');
    expect(labels).toContain('Agent sandbox');
    expect(labels).not.toContain('Managed git');
    expect(missing.some((m) => m.hint.includes('OPENROUTER_API_KEY'))).toBe(false);
    expect(sandboxProviderConfigured(baseEnv())).toBe(false);
    expect(gitProviderConfigured(baseEnv())).toBe(false);
  });

  test('Daytona alone (no managed git, no OpenRouter) reports nothing missing', () => {
    const env = baseEnv({ DAYTONA_API_KEY: 'dtn_live_key' });
    expect(missingRequiredSecrets(env)).toEqual([]);
    expect(sandboxProviderConfigured(env)).toBe(true);
    expect(gitProviderConfigured(env)).toBe(false);
  });

  test('local-docker (EXPERIMENTAL) alone reports nothing missing — no provider API key required', () => {
    const env = baseEnv({ ALLOWED_SANDBOX_PROVIDERS: 'local-docker', DAYTONA_API_KEY: '' });
    expect(missingRequiredSecrets(env)).toEqual([]);
    expect(sandboxProviderConfigured(env)).toBe(true);
  });

  test('a fully-configured env (Daytona + GitHub PAT + OpenRouter) also reports nothing missing', () => {
    const env = baseEnv({
      DAYTONA_API_KEY: 'dtn_live_key',
      MANAGED_GIT_GITHUB_OWNER: 'kortix-ai',
      MANAGED_GIT_GITHUB_TOKEN: 'ghp_faketoken',
      OPENROUTER_API_KEY: 'sk-or-fake',
    });
    expect(missingRequiredSecrets(env)).toEqual([]);
    expect(sandboxProviderConfigured(env)).toBe(true);
    expect(gitProviderConfigured(env)).toBe(true);
  });

  test('managed-git owner set but no PAT/App credentials: gitProviderConfigured is still false, but this no longer blocks init/start', () => {
    const env = baseEnv({
      DAYTONA_API_KEY: 'dtn_live_key',
      OPENROUTER_API_KEY: 'sk-or-fake',
      MANAGED_GIT_GITHUB_OWNER: 'kortix-ai', // owner alone is not enough
    });
    expect(gitProviderConfigured(env)).toBe(false);
    expect(missingRequiredSecrets(env)).toEqual([]);
  });

  test('a complete GitHub App credential set (no PAT) satisfies gitProviderConfigured', () => {
    const env = baseEnv({
      DAYTONA_API_KEY: 'dtn_live_key',
      OPENROUTER_API_KEY: 'sk-or-fake',
      MANAGED_GIT_GITHUB_OWNER: 'kortix-ai',
      KORTIX_GITHUB_APP_ID: '123456',
      KORTIX_GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----',
      MANAGED_GIT_GITHUB_INSTALL_ID: '987654',
    });
    expect(gitProviderConfigured(env)).toBe(true);
    expect(missingRequiredSecrets(env)).toEqual([]);
  });

  test('a corrupted/blanked-out internal generated secret is reported even though the sandbox provider is configured', () => {
    const env = baseEnv({
      DAYTONA_API_KEY: 'dtn_live_key',
      MANAGED_GIT_GITHUB_OWNER: 'kortix-ai',
      MANAGED_GIT_GITHUB_TOKEN: 'ghp_faketoken',
      OPENROUTER_API_KEY: 'sk-or-fake',
      TUNNEL_SIGNING_SECRET: '', // e.g. hand-edited .env with a blanked line
    });
    const missing = missingRequiredSecrets(env);
    expect(missing.some((m) => m.hint.includes('TUNNEL_SIGNING_SECRET'))).toBe(true);
  });
});

describe('shouldPullImages', () => {
  test('true when KORTIX_IMAGE_PULL is unset (normal registry pull behavior)', () => {
    expect(shouldPullImages({})).toBe(true);
  });

  test('false for KORTIX_IMAGE_PULL=never (--local-images dev mode) — a blanket `docker compose pull` would fail with "manifest unknown" against images that were only ever built locally', () => {
    expect(shouldPullImages({ KORTIX_IMAGE_PULL: 'never' })).toBe(false);
  });

  test('true for any other value (defensive — only the literal "never" opts out)', () => {
    expect(shouldPullImages({ KORTIX_IMAGE_PULL: '' })).toBe(true);
    expect(shouldPullImages({ KORTIX_IMAGE_PULL: 'always' })).toBe(true);
  });
});

// ── `kortix self-host env` CLI black-box coverage ────────────────────────────

const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');

// IMPORTANT: every invocation below is pinned to a random, never-reused
// `--instance` name. `env set`/`env rotate` (unlike every other
// command self-host-cli.test.ts exercises) shell out to real `docker
// compose` to decide whether anything needs restarting — and the Compose
// *project name* is derived only from `--instance` (see composeProject()),
// not from KORTIX_SELF_HOST_CONFIG_DIR. Using the default instance name here
// would target the SAME Docker Compose project as a real `kortix self-host`
// deployment a developer has actually running on this machine, which is
// exactly the collision that bit an earlier version of this test file (it
// recreated a live `kortix-default` container). A fresh random instance name
// per test run guarantees `docker compose ps` finds no running services for
// it, so the CLI takes the safe "stack isn't running" branch and never
// issues a mutating `docker compose up`.
let instanceCounter = 0;
function uniqueInstance(): string {
  instanceCounter += 1;
  return `kortixtest${Date.now()}${instanceCounter}`;
}

describe('kortix self-host env (CLI)', () => {
  let tmp: string;
  let configRoot: string;
  let instance: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-self-host-env-'));
    configRoot = join(tmp, 'self-host');
    instance = uniqueInstance();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function run(args: string[]) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args, '--instance', instance],
      cwd: tmp,
      env: {
        ...process.env,
        KORTIX_SELF_HOST_CONFIG_DIR: configRoot,
        KORTIX_CONFIG_FILE: join(tmp, 'cli-config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  function readEnv(): Record<string, string> {
    const content = readFileSync(join(configRoot, instance, '.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  }

  test('env ls lists every category and surfaces missing required secrets', async () => {
    await run(['init', '--yes']);
    const { code, stdout } = await run(['env', 'ls']);
    expect(code).toBe(0);
    expect(stdout).toContain('Database & Supabase');
    expect(stdout).toContain('Managed git');
    expect(stdout).toContain('Missing required');
    expect(stdout).toContain('Agent sandbox runtime');
  });

  test('env ls masks values by default and only reveals them with --show', async () => {
    await run(['init', '--yes']);
    await run(['env', 'set', 'OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop']);

    const masked = await run(['env', 'ls']);
    expect(masked.stdout).not.toContain('sk-or-v1-abcdefghijklmnop');

    const shown = await run(['env', 'ls', '--show']);
    expect(shown.stdout).toContain('sk-or-v1-abcdefghijklmnop');
  });

  test('env set KEY=VALUE persists the value and satisfies the LLM requirement', async () => {
    await run(['init', '--yes']);
    const { code } = await run(['env', 'set', 'OPENROUTER_API_KEY=sk-or-test-123']);
    expect(code).toBe(0);
    expect(readEnv().OPENROUTER_API_KEY).toBe('sk-or-test-123');
  });

  test('env set refuses to hand-set an updater-managed key', async () => {
    await run(['init', '--yes']);
    const before = readEnv().KORTIX_VERSION;
    const { code, stderr } = await run(['env', 'set', 'KORTIX_VERSION=9.9.9']);
    expect(code).toBe(2);
    expect(stderr).toContain('updater');
    expect(readEnv().KORTIX_VERSION).toBe(before);
  });

  test('KORTIX_INSTANCE_DIR is the absolute instance directory and env set refuses to hand-set it', async () => {
    await run(['init', '--yes']);
    // Must be the real, absolute on-disk path this instance's compose/env
    // live in — see the KORTIX_INSTANCE_DIR field doc comment on SelfHostEnv
    // (commands/self-host.ts) for why the in-compose updater's DinD bind
    // mount depends on this being exactly right.
    expect(readEnv().KORTIX_INSTANCE_DIR).toBe(join(configRoot, instance));

    const { code, stderr } = await run(['env', 'set', 'KORTIX_INSTANCE_DIR=/tmp/somewhere-else']);
    expect(code).toBe(2);
    expect(stderr).toContain('updater');
    expect(readEnv().KORTIX_INSTANCE_DIR).toBe(join(configRoot, instance));
  });

  test('env rotate DASHBOARD_PASSWORD regenerates only that value', async () => {
    await run(['init', '--yes']);
    const before = readEnv();
    const { code } = await run(['env', 'rotate', 'DASHBOARD_PASSWORD']);
    expect(code).toBe(0);
    const after = readEnv();
    expect(after.DASHBOARD_PASSWORD).not.toBe(before.DASHBOARD_PASSWORD);
    expect(after.POSTGRES_PASSWORD).toBe(before.POSTGRES_PASSWORD);
  });

  test('env rotate SUPABASE_JWT_SECRET cascades into the derived anon/service-role JWTs', async () => {
    await run(['init', '--yes']);
    const before = readEnv();
    const { code } = await run(['env', 'rotate', 'SUPABASE_JWT_SECRET']);
    expect(code).toBe(0);
    const after = readEnv();
    expect(after.SUPABASE_JWT_SECRET).not.toBe(before.SUPABASE_JWT_SECRET);
    expect(after.SUPABASE_ANON_KEY).not.toBe(before.SUPABASE_ANON_KEY);
    expect(after.SUPABASE_SERVICE_ROLE_KEY).not.toBe(before.SUPABASE_SERVICE_ROLE_KEY);
  });

  test('env rotate refuses a non-rotatable internal-infra generated key', async () => {
    await run(['init', '--yes']);
    const before = readEnv().SECRET_KEY_BASE;
    const { code, stderr } = await run(['env', 'rotate', 'SECRET_KEY_BASE']);
    expect(code).toBe(2);
    expect(stderr).toContain('Refusing to rotate');
    expect(readEnv().SECRET_KEY_BASE).toBe(before);
  });

  test('env rotate --all-generated rotates every rotatable key and leaves non-rotatable infra keys untouched', async () => {
    await run(['init', '--yes']);
    const before = readEnv();
    const { code } = await run(['env', 'rotate', '--all-generated']);
    expect(code).toBe(0);
    const after = readEnv();
    expect(after.POSTGRES_PASSWORD).not.toBe(before.POSTGRES_PASSWORD);
    expect(after.DASHBOARD_PASSWORD).not.toBe(before.DASHBOARD_PASSWORD);
    expect(after.GATEWAY_INTERNAL_TOKEN).not.toBe(before.GATEWAY_INTERNAL_TOKEN);
    expect(after.TUNNEL_SIGNING_SECRET).not.toBe(before.TUNNEL_SIGNING_SECRET);
    // Deliberately excluded infra keys must survive untouched.
    expect(after.SECRET_KEY_BASE).toBe(before.SECRET_KEY_BASE);
    expect(after.VAULT_ENC_KEY).toBe(before.VAULT_ENC_KEY);
    expect(after.DASHBOARD_USERNAME).toBe(before.DASHBOARD_USERNAME);
  });
});

// ── init/start required secrets: warn, never hard-block ─────────────────────

describe('kortix self-host init/start required-secrets warning (CLI)', () => {
  let tmp: string;
  let configRoot: string;
  let instance: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-self-host-enforce-'));
    configRoot = join(tmp, 'self-host');
    instance = uniqueInstance();
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function run(args: string[]) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args, '--instance', instance],
      cwd: tmp,
      env: {
        ...process.env,
        KORTIX_SELF_HOST_CONFIG_DIR: configRoot,
        KORTIX_CONFIG_FILE: join(tmp, 'cli-config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test('a non-interactive `init` with no secrets configured warns but still exits 0', async () => {
    const { code, stdout } = await run(['init', '--yes']);
    expect(code).toBe(0);
    expect(stdout).toContain('Proceeding with required secrets missing');
    expect(stdout).toContain('kortix self-host env set');
  });

  // `start` genuinely shells out to `docker compose pull`/`up` once past this
  // point, which this "fast, no Docker" suite must never trigger for real —
  // so this exercises the exact same ensureRequiredSecrets() code path
  // `start` uses via a second `init` call instead (selfHostInit never
  // touches docker).
  test('a later plain `init` on the same instance still warns until the secret is actually set', async () => {
    const first = await run(['init', '--yes']);
    expect(first.code).toBe(0);

    const second = await run(['init', '--yes']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('Proceeding with required secrets missing');
  });

  test('once the actual secret is set, the warning naturally clears', async () => {
    await run(['init', '--yes']);
    await run(['env', 'set', 'DAYTONA_API_KEY=dtn-test-key']);

    const { code, stdout } = await run(['init', '--yes']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('Proceeding with required secrets missing');
  });
});
