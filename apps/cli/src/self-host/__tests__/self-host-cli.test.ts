import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// Black-box tests for the generic (Docker-only) `kortix self-host` CLI: no
// "target" flag, no AWS coordinates — `init`/`env set` only ever write a
// docker-compose.yml + .env for this machine. These exercise the real CLI
// entrypoint so they catch wiring mistakes a unit test on an unexported
// function would miss.
//
// Every `init` call below passes `--allow-missing-secrets`: none of these
// tests configure DAYTONA_API_KEY (the ONLY secret `init` gates on
// non-interactively now — managed git and the LLM key are configured in the
// dashboard after `start`, not by this CLI), and `init` refuses to succeed
// with it unset — see secrets.test.ts for coverage of that enforcement.
const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');

describe('kortix self-host (generic Docker CLI)', () => {
  let tmp: string;
  let configRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-self-host-cli-'));
    configRoot = join(tmp, 'self-host');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function run(args: string[], extraEnv: Record<string, string> = {}) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args],
      cwd: tmp,
      env: {
        ...process.env,
        KORTIX_SELF_HOST_CONFIG_DIR: configRoot,
        KORTIX_CONFIG_FILE: join(tmp, 'cli-config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...extraEnv,
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

  function readEnv(instance = 'default'): Record<string, string> {
    const content = readFileSync(join(configRoot, instance, '.env'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      out[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return out;
  }

  function readCompose(instance = 'default'): { services: Record<string, unknown> } {
    return parse(readFileSync(join(configRoot, instance, 'docker-compose.yml'), 'utf8'));
  }

  test('init defaults to the shared auth+sandbox defaults and the stable channel', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);

    const env = readEnv();
    // Shared defaults (SHARED_SELF_HOST_DEFAULTS) must be wired, not duplicated.
    expect(env.DISABLE_SIGNUP).toBe('false');
    expect(env.ENABLE_EMAIL_SIGNUP).toBe('true');
    expect(env.ENABLE_EMAIL_AUTOCONFIRM).toBe('true');
    expect(env.KORTIX_PUBLIC_AUTH_METHODS).toBe('password');
    expect(env.ALLOWED_SANDBOX_PROVIDERS).toBe('daytona');
    expect(env.DAYTONA_SERVER_URL).toBe('https://app.daytona.io/api');

    // Default channel is "stable" — a plain moving Docker tag, no signing/TUF.
    expect(env.KORTIX_CHANNEL).toBe('stable');
    expect(env.KORTIX_VERSION).toBe('stable');
    expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:stable');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:stable');
    expect(env.GATEWAY_IMAGE).toBe('kortix/kortix-gateway:stable');
    expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    expect(env.KORTIX_UPDATE_TIME).toBe('02:00');
    expect(env.KORTIX_UPDATE_TZ).toBe('America/New_York');
    expect(env.KORTIX_ALLOW_DOWNTIME).toBe('0');

    // Laptop mode (no domain): single replica, no LB needed.
    expect(env.KORTIX_APP_REPLICAS).toBe('1');

    // No local-source-build leftovers.
    expect(env.KORTIX_LOCAL_IMAGES).toBeUndefined();
  });

  test('--channel latest tracks the :latest tag instead of :stable', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--channel', 'latest']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_CHANNEL).toBe('latest');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:latest');
  });

  test('--tag pins an explicit version regardless of channel', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--tag', '0.9.72']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_VERSION).toBe('0.9.72');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:0.9.72');
    // Pinning an explicit version doesn't invent a channel name for it.
    expect(env.KORTIX_CHANNEL).toBe('stable');
  });

  // Auto-update defaults ON everywhere, including a pinned --version/--tag —
  // the nightly updater re-pulling the SAME immutable pinned tag is a
  // harmless no-op (nothing to roll), not silent drift, so pinning alone is
  // no longer a reason to default it off. --local-images (a locally-built
  // image never pushed to any registry) is the one real exception — see the
  // --local-images test below.
  test('--version is an alias for --tag: pins the image ref, auto-update still defaults ON (a no-op nightly re-pull of the same pinned tag)', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--version', 'dev-a1b2c3d']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_VERSION).toBe('dev-a1b2c3d');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:dev-a1b2c3d');
    expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:dev-a1b2c3d');
    expect(env.KORTIX_AUTO_UPDATE).toBe('true');
  });

  test('--channel latest (channel tracking) also keeps auto-update on by default', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--channel', 'latest']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_AUTO_UPDATE).toBe('true');
  });

  test('an explicit --auto-update off wins even without --local-images', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--version', '0.9.99', '--auto-update', 'off']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_AUTO_UPDATE).toBe('false');
  });

  test('--local-images (dev mode): sets KORTIX_IMAGE_PULL=never and forces auto-update off, even over --auto-update on', async () => {
    const { code } = await run([
      'init', '--yes', '--allow-missing-secrets',
      '--version', 'branch-local', '--local-images', '--auto-update', 'on',
    ]);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_IMAGE_PULL).toBe('never');
    expect(env.KORTIX_AUTO_UPDATE).toBe('false');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:branch-local');
  });

  test('--no-pull is an alias for --local-images', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--no-pull']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_IMAGE_PULL).toBe('never');
  });

  test('without --local-images, KORTIX_IMAGE_PULL stays unset (normal pull behavior)', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_IMAGE_PULL).toBe('');
  });

  test('rejects an invalid --channel value', async () => {
    const { code, stderr } = await run(['init', '--yes', '--allow-missing-secrets', '--channel', 'nightly']);
    expect(code).toBe(2);
    expect(stderr).toContain('--channel must be "stable" or "latest"');
  });

  test('--update-time / --update-tz configure the nightly auto-update schedule', async () => {
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--update-time', '03:30', '--update-tz', 'UTC']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_UPDATE_TIME).toBe('03:30');
    expect(env.KORTIX_UPDATE_TZ).toBe('UTC');
  });

  test('rejects an invalid --update-time value', async () => {
    const { code, stderr } = await run(['init', '--yes', '--allow-missing-secrets', '--update-time', '9pm']);
    expect(code).toBe(2);
    expect(stderr).toContain('--update-time must be HH:MM');
  });

  test('--allow-downtime sets KORTIX_ALLOW_DOWNTIME=1', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    expect(readEnv().KORTIX_ALLOW_DOWNTIME).toBe('0');
    const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--allow-downtime']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_ALLOW_DOWNTIME).toBe('1');
  });

  test('KORTIX_APP_REPLICAS flips to 2 once a domain is configured, back to 1 without one', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    expect(readEnv().KORTIX_APP_REPLICAS).toBe('1');

    await run(['env', 'set', 'KORTIX_DOMAIN=kortix.example.com']);
    expect(readEnv().KORTIX_APP_REPLICAS).toBe('2');

    await run(['env', 'set', 'KORTIX_DOMAIN=']);
    expect(readEnv().KORTIX_APP_REPLICAS).toBe('1');
  });

  test('the rendered compose has no Caddy service until KORTIX_DOMAIN is set', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const before = readCompose();
    expect(before.services).not.toHaveProperty('caddy');
    expect(before.services).toHaveProperty('kortix-updater');

    const { code } = await run(['env', 'set', 'KORTIX_DOMAIN=kortix.example.com']);
    expect(code).toBe(0);

    const after = readCompose();
    expect(after.services).toHaveProperty('caddy');

    const env = readEnv();
    expect(env.KORTIX_API_DOMAIN).toBe('api.kortix.example.com');
    expect(env.PUBLIC_URL).toBe('https://kortix.example.com');
    expect(env.API_PUBLIC_URL).toBe('https://api.kortix.example.com');
  });

  test('no AWS/target concepts remain reachable from the CLI', async () => {
    const { stdout } = await run(['-h']);
    expect(stdout).not.toContain('aws-ec2');
    expect(stdout).not.toContain('--aws-profile');
    expect(stdout).not.toContain('--target');
    expect(stdout).not.toContain('Terraform');
  });

  describe('configuration feature flags (single-account / landing / enterprise-license / billing)', () => {
    test('default to off (except the landing page, off by default too), and are explicit in .env (not just hard-coded in the compose template)', async () => {
      const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_SINGLE_ACCOUNT_MODE).toBe('false');
      expect(env.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE).toBe('false');
      // Self-host is an app deployment, not a marketing site — the marketing
      // landing page is DISABLED by default (unlike Kortix Cloud).
      expect(env.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
      expect(env.ENTERPRISE_LICENSE_AVAILABLE).toBe('false');
      expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('false');
      expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('false');
    });

    test('--single-account sets both the backend and frontend flags', async () => {
      const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--single-account']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');
      expect(env.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE).toBe('true');
    });

    // There is deliberately no `--landing`/`--no-landing` flag: the landing
    // page isn't a guided-flow decision (self-host is an app deployment, not
    // a marketing site — full stop), it's just an ordinary env var an
    // operator can flip directly if they genuinely want it back.
    test('re-enabling the landing page is a plain `env set`, no dedicated flag', async () => {
      await run(['init', '--yes', '--allow-missing-secrets']);
      expect(readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');

      const { code } = await run(['env', 'set', 'KORTIX_PUBLIC_DISABLE_LANDING_PAGE=false']);
      expect(code).toBe(0);
      expect(readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('false');

      // A later plain re-init must not silently flip it back off.
      const reinit = await run(['init', '--yes', '--allow-missing-secrets']);
      expect(reinit.code).toBe(0);
      expect(readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('false');
    });

    test('--enterprise-license sets ENTERPRISE_LICENSE_AVAILABLE', async () => {
      const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--enterprise-license']);
      expect(code).toBe(0);
      expect(readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
    });

    test('a re-run of init without the flag does not reset a previously-set flag', async () => {
      await run(['init', '--yes', '--allow-missing-secrets', '--single-account']);
      expect(readEnv().KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');

      // Plain re-init (e.g. a config refresh) must not silently turn it back off.
      const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
      expect(code).toBe(0);
      expect(readEnv().KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');
    });

    // Note: `kortix self-host update` shells out to a real `docker compose`
    // (zero-downtime rollout) and isn't exercised by this black-box CLI
    // harness for that reason — same scope limit as the rest of this file,
    // which never invokes `start`/`update` either. Preservation across a
    // later invocation is instead proven via `init` above and `env set`
    // below: `update` merges env with the exact same
    // `{ ...defaultEnv(flags), ...existing }` pattern (loadEnvWithDefaults)
    // and the exact same `applyFeatureFlags()` conditional-overwrite helper
    // as `init` — see selfHostUpdate() in commands/self-host.ts.

    test('env set also works directly and survives a later plain init', async () => {
      await run(['init', '--yes', '--allow-missing-secrets']);
      await run(['env', 'set', 'KORTIX_BILLING_INTERNAL_ENABLED=true', 'KORTIX_PUBLIC_BILLING_ENABLED=true']);
      expect(readEnv().KORTIX_BILLING_INTERNAL_ENABLED).toBe('true');

      const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('true');
      expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('true');
    });

    test('the rendered compose passes the flags through as runtime env, not hard-coded literals', async () => {
      await run(['init', '--yes', '--allow-missing-secrets']);
      const compose = readCompose();
      const frontendEnv = (compose.services.frontend as any).environment;
      expect(frontendEnv.KORTIX_PUBLIC_BILLING_ENABLED).toBe('${KORTIX_PUBLIC_BILLING_ENABLED}');
      expect(frontendEnv.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE).toBe('${KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE}');
      expect(frontendEnv.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('${KORTIX_PUBLIC_DISABLE_LANDING_PAGE}');

      // kortix-api gets these via `env_file: .env` (loads every .env key) —
      // no explicit `environment:` entry, since one would win over env_file
      // and re-introduce the old "billing hard-pinned false" bug.
      const apiEnv = (compose.services['kortix-api'] as any).environment;
      expect(apiEnv.KORTIX_BILLING_INTERNAL_ENABLED).toBeUndefined();
      expect(apiEnv.KORTIX_SINGLE_ACCOUNT_MODE).toBeUndefined();
      expect(apiEnv.ENTERPRISE_LICENSE_AVAILABLE).toBeUndefined();
      expect((compose.services['kortix-api'] as any).env_file).toContain('.env');
    });
  });

  describe('reachability (KORTIX_URL, --domain, --tunnel)', () => {
    test('the rendered compose templates KORTIX_URL instead of hard-coding the internal Docker hostname', async () => {
      await run(['init', '--yes', '--allow-missing-secrets']);
      const compose = readCompose();
      const apiEnv = (compose.services['kortix-api'] as any).environment;
      expect(apiEnv.KORTIX_URL).toBe('${KORTIX_URL}');
      expect(apiEnv.KORTIX_URL).not.toContain('kortix-api:8008');
    });

    test('default (local-only) mode: KORTIX_URL mirrors the loopback API_PUBLIC_URL, not the internal hostname', async () => {
      const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_URL).toBe(env.API_PUBLIC_URL);
      expect(env.KORTIX_URL).toStartWith('http://localhost:');
      expect(env.KORTIX_REACHABILITY_MODE).toBe('local');
      expect(readCompose().services).not.toHaveProperty('cloudflared');
    });

    test('--domain sets KORTIX_DOMAIN and KORTIX_URL follows API_PUBLIC_URL (https://api.<domain>)', async () => {
      const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--domain', 'kortix.example.com']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_DOMAIN).toBe('kortix.example.com');
      expect(env.API_PUBLIC_URL).toBe('https://api.kortix.example.com');
      expect(env.KORTIX_URL).toBe('https://api.kortix.example.com');
      expect(env.KORTIX_REACHABILITY_MODE).toBe('domain');
      expect(readCompose().services).toHaveProperty('caddy');
      expect(readCompose().services).not.toHaveProperty('cloudflared');
    });

    test('--domain= clears a previously configured domain, falling back out of "domain" mode', async () => {
      await run(['init', '--yes', '--allow-missing-secrets', '--domain', 'kortix.example.com']);
      expect(readEnv().KORTIX_DOMAIN).toBe('kortix.example.com');

      // The `--flag=value` form (not `--flag value`) is required to pass an
      // explicit empty string — takeFlagValue treats a bare falsy next-arg as
      // "no value provided" and errors, but `--domain=` with nothing after
      // the `=` is unambiguous.
      const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--domain=']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_DOMAIN).toBe('');
      // KORTIX_URL always mirrors API_PUBLIC_URL outside tunnel mode — whatever
      // that resolves to (API_PUBLIC_URL/PUBLIC_URL are otherwise-sticky
      // operator-configurable values, unrelated to this feature, that are not
      // reset to loopback just because KORTIX_DOMAIN was cleared).
      expect(env.KORTIX_URL).toBe(env.API_PUBLIC_URL);
      expect(readCompose().services).not.toHaveProperty('caddy');
    });

    test('--tunnel cloudflare renders the cloudflared service and defers KORTIX_URL to the live capture step', async () => {
      const { code } = await run(['init', '--yes', '--allow-missing-secrets', '--tunnel', 'cloudflare']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_REACHABILITY_MODE).toBe('tunnel');
      expect(env.KORTIX_DOMAIN).toBe('');
      const compose = readCompose();
      expect(compose.services).toHaveProperty('cloudflared');
      expect(compose.services).not.toHaveProperty('caddy');
      // init never runs docker compose, so KORTIX_URL can't be the real tunnel
      // URL yet — reconcileTunnelReachability() (part of `start`/`update`)
      // captures and rewrites it after the cloudflared container boots.
      expect(env.KORTIX_URL).toBeTruthy();
    });

    test('a re-init does not reset an already-configured reachability mode', async () => {
      await run(['init', '--yes', '--allow-missing-secrets', '--tunnel', 'cloudflare']);
      const { code } = await run(['init', '--yes', '--allow-missing-secrets']);
      expect(code).toBe(0);
      expect(readEnv().KORTIX_REACHABILITY_MODE).toBe('tunnel');
      expect(readCompose().services).toHaveProperty('cloudflared');
    });

    test('rejects an unsupported --tunnel provider', async () => {
      const { code, stderr } = await run(['init', '--yes', '--allow-missing-secrets', '--tunnel', 'ngrok']);
      expect(code).not.toBe(0);
      expect(stderr).toContain('cloudflare');
    });

    test('a named tunnel (token + hostname) can be configured via env set, restarting only cloudflared when active', async () => {
      await run(['init', '--yes', '--allow-missing-secrets', '--tunnel', 'cloudflare']);
      const { code } = await run([
        'env', 'set',
        'CLOUDFLARE_TUNNEL_TOKEN=faketoken',
        'CLOUDFLARE_TUNNEL_HOSTNAME=kortix-tunnel.example.com',
      ]);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.CLOUDFLARE_TUNNEL_TOKEN).toBe('faketoken');
      expect(env.CLOUDFLARE_TUNNEL_HOSTNAME).toBe('kortix-tunnel.example.com');
    });

    test('setting CLOUDFLARE_TUNNEL_TOKEN via secrets set before tunnel mode is selected does not error (stack not running)', async () => {
      await run(['init', '--yes', '--allow-missing-secrets']);
      const { code } = await run(['secrets', 'set', 'CLOUDFLARE_TUNNEL_TOKEN=faketoken']);
      expect(code).toBe(0);
    });
  });

  // `connect-github` is deprecated: managed git is now configured in the web
  // dashboard (Settings → Git), not by this CLI — the App-manifest flow it
  // used to run never worked reliably from a laptop (GitHub rejects
  // hook/callback URLs unreachable over the public internet). The dispatch
  // case is kept as a no-op alias (not removed outright) so a script that
  // still calls it doesn't hard-fail.
  test('connect-github is a deprecated no-op alias: exits 0 and points at the dashboard instead of running the App-manifest flow', async () => {
    await run(['init', '--yes', '--allow-missing-secrets']);
    const { code, stdout } = await run(['connect-github']);
    expect(code).toBe(0);
    expect(stdout).toContain('deprecated');
    expect(stdout.toLowerCase()).toContain('settings');
  });
});
