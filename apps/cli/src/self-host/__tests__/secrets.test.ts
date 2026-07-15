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
import { gitProviderConfigured, missingRequiredSecrets, sandboxProviderConfigured } from '../../commands/self-host.ts';

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
    ...overrides,
  };
}

describe('missingRequiredSecrets', () => {
  test('a fresh (just-initialized, nothing configured) env reports sandbox, managed git, and LLM', () => {
    const missing = missingRequiredSecrets(baseEnv());
    const labels = missing.map((m) => m.label).join(' | ');
    expect(labels).toContain('Agent sandbox');
    expect(labels).toContain('Managed git');
    expect(missing.some((m) => m.hint.includes('OPENROUTER_API_KEY'))).toBe(true);
    expect(sandboxProviderConfigured(baseEnv())).toBe(false);
    expect(gitProviderConfigured(baseEnv())).toBe(false);
  });

  test('a fully-configured env (Daytona + GitHub PAT + OpenRouter) reports nothing missing', () => {
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

  test('managed-git owner set but no PAT/App credentials still counts as missing', () => {
    const env = baseEnv({
      DAYTONA_API_KEY: 'dtn_live_key',
      OPENROUTER_API_KEY: 'sk-or-fake',
      MANAGED_GIT_GITHUB_OWNER: 'kortix-ai', // owner alone is not enough
    });
    expect(gitProviderConfigured(env)).toBe(false);
    const missing = missingRequiredSecrets(env);
    expect(missing.some((m) => m.label.includes('Managed git'))).toBe(true);
  });

  test('a complete GitHub App credential set (no PAT) satisfies managed git', () => {
    const env = baseEnv({
      DAYTONA_API_KEY: 'dtn_live_key',
      OPENROUTER_API_KEY: 'sk-or-fake',
      MANAGED_GIT_GITHUB_OWNER: 'kortix-ai',
      KORTIX_GITHUB_APP_ID: '123456',
      KORTIX_GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----',
      MANAGED_GIT_GITHUB_INSTALL_ID: '987654',
    });
    expect(gitProviderConfigured(env)).toBe(true);
    expect(missingRequiredSecrets(env).some((m) => m.label.includes('Managed git'))).toBe(false);
  });

  test('a corrupted/blanked-out internal generated secret is reported even though every provider is configured', () => {
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

// ── `kortix self-host secrets` CLI black-box coverage ────────────────────────

const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');

// IMPORTANT: every invocation below is pinned to a random, never-reused
// `--instance` name. `secrets set`/`secrets rotate` (unlike every other
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

describe('kortix self-host secrets (CLI)', () => {
  let tmp: string;
  let configRoot: string;
  let instance: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-self-host-secrets-'));
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

  test('secrets ls lists every category and surfaces missing required secrets', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const { code, stdout } = await run(['secrets', 'ls']);
    expect(code).toBe(0);
    expect(stdout).toContain('Database & Supabase');
    expect(stdout).toContain('Managed git');
    expect(stdout).toContain('Missing required');
    expect(stdout).toContain('Agent sandbox runtime');
  });

  test('secrets ls masks values by default and only reveals them with --show', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    await run(['secrets', 'set', 'OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop']);

    const masked = await run(['secrets', 'ls']);
    expect(masked.stdout).not.toContain('sk-or-v1-abcdefghijklmnop');

    const shown = await run(['secrets', 'ls', '--show']);
    expect(shown.stdout).toContain('sk-or-v1-abcdefghijklmnop');
  });

  test('secrets set KEY=VALUE persists the value and satisfies the LLM requirement', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const { code } = await run(['secrets', 'set', 'OPENROUTER_API_KEY=sk-or-test-123']);
    expect(code).toBe(0);
    expect(readEnv().OPENROUTER_API_KEY).toBe('sk-or-test-123');
  });

  test('secrets set refuses to hand-set an updater-managed key', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const before = readEnv().KORTIX_VERSION;
    const { code, stderr } = await run(['secrets', 'set', 'KORTIX_VERSION=9.9.9']);
    expect(code).toBe(2);
    expect(stderr).toContain('updater');
    expect(readEnv().KORTIX_VERSION).toBe(before);
  });

  test('secrets rotate DASHBOARD_PASSWORD regenerates only that value', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const before = readEnv();
    const { code } = await run(['secrets', 'rotate', 'DASHBOARD_PASSWORD']);
    expect(code).toBe(0);
    const after = readEnv();
    expect(after.DASHBOARD_PASSWORD).not.toBe(before.DASHBOARD_PASSWORD);
    expect(after.POSTGRES_PASSWORD).toBe(before.POSTGRES_PASSWORD);
  });

  test('secrets rotate SUPABASE_JWT_SECRET cascades into the derived anon/service-role JWTs', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const before = readEnv();
    const { code } = await run(['secrets', 'rotate', 'SUPABASE_JWT_SECRET']);
    expect(code).toBe(0);
    const after = readEnv();
    expect(after.SUPABASE_JWT_SECRET).not.toBe(before.SUPABASE_JWT_SECRET);
    expect(after.SUPABASE_ANON_KEY).not.toBe(before.SUPABASE_ANON_KEY);
    expect(after.SUPABASE_SERVICE_ROLE_KEY).not.toBe(before.SUPABASE_SERVICE_ROLE_KEY);
  });

  test('secrets rotate refuses a non-rotatable internal-infra generated key', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const before = readEnv().SECRET_KEY_BASE;
    const { code, stderr } = await run(['secrets', 'rotate', 'SECRET_KEY_BASE']);
    expect(code).toBe(2);
    expect(stderr).toContain('Refusing to rotate');
    expect(readEnv().SECRET_KEY_BASE).toBe(before);
  });

  test('secrets rotate --all-generated rotates every rotatable key and leaves non-rotatable infra keys untouched', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const before = readEnv();
    const { code } = await run(['secrets', 'rotate', '--all-generated']);
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

// ── init/start enforcement of required secrets ───────────────────────────────

describe('kortix self-host init/start required-secrets enforcement (CLI)', () => {
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

  test('a non-interactive `init` with no secrets configured fails with an itemized, actionable message', async () => {
    const { code, stderr } = await run(['init', '--yes']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('Required secrets are missing');
    expect(stderr).toContain('kortix self-host secrets set');
    expect(stderr).toContain('--allow-missing-secrets');
  });

  test('--allow-missing-secrets downgrades the same situation to a warning and exits 0', async () => {
    const { code, stdout } = await run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('unknown');
  });

  test('a fully-configured init via env set + secrets set on top of --allow-missing-secrets, then a plain start guard still enforces on a later start', async () => {
    // init once, letting secrets stay unset...
    await run(['init', '--yes', '--allow-missing-secrets']);
    // ...then run `start` on the already-initialized instance without the
    // escape hatch: it must refuse too, not just `init`.
    const { code, stderr } = await run(['start', '--yes']);
    expect(code).not.toBe(0);
    expect(stderr).toContain('Required secrets are missing');
  });
});
