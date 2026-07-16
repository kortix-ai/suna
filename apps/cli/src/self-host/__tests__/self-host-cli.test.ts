import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

// Black-box tests for the generic (Docker-only) `kortix self-host` CLI: no
// "target" flag, no AWS coordinates — `init`/`env set` only ever write a
// docker-compose.yml + .env for this machine. These exercise the real CLI
// entrypoint so they catch wiring mistakes a unit test on an unexported
// function would miss.
//
// None of these tests configure DAYTONA_API_KEY (the sandbox key `init` asks
// about — managed git and the LLM key are configured in the dashboard after
// `start`, not by this CLI). `init`/`start` never hard-fail on a missing
// secret — they warn and proceed; see secrets.test.ts for coverage of that
// warning behavior.
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
    const { code } = await run(['init', '--yes']);
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
    const { code } = await run(['init', '--yes', '--channel', 'latest']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_CHANNEL).toBe('latest');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:latest');
  });

  test('--tag pins an explicit version regardless of channel', async () => {
    const { code } = await run(['init', '--yes', '--tag', '0.9.72']);
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
    const { code } = await run(['init', '--yes', '--version', 'dev-a1b2c3d']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_VERSION).toBe('dev-a1b2c3d');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:dev-a1b2c3d');
    expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:dev-a1b2c3d');
    expect(env.KORTIX_AUTO_UPDATE).toBe('true');
  });

  test('--channel latest (channel tracking) also keeps auto-update on by default', async () => {
    const { code } = await run(['init', '--yes', '--channel', 'latest']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_AUTO_UPDATE).toBe('true');
  });

  test('an explicit --auto-update off wins even without --local-images', async () => {
    const { code } = await run(['init', '--yes', '--version', '0.9.99', '--auto-update', 'off']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_AUTO_UPDATE).toBe('false');
  });

  test('--local-images (dev mode): sets KORTIX_IMAGE_PULL=never and forces auto-update off, even over --auto-update on', async () => {
    const { code } = await run([
      'init', '--yes',
      '--version', 'branch-local', '--local-images', '--auto-update', 'on',
    ]);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_IMAGE_PULL).toBe('never');
    expect(env.KORTIX_AUTO_UPDATE).toBe('false');
    expect(env.API_IMAGE).toBe('kortix/kortix-api:branch-local');
  });

  test('--no-pull is an alias for --local-images', async () => {
    const { code } = await run(['init', '--yes', '--no-pull']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_IMAGE_PULL).toBe('never');
  });

  test('without --local-images, KORTIX_IMAGE_PULL stays unset (normal pull behavior)', async () => {
    const { code } = await run(['init', '--yes']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_IMAGE_PULL).toBe('');
  });

  test('rejects an invalid --channel value', async () => {
    const { code, stderr } = await run(['init', '--yes', '--channel', 'nightly']);
    expect(code).toBe(2);
    expect(stderr).toContain('--channel must be "stable" or "latest"');
  });

  test('--update-time / --update-tz configure the nightly auto-update schedule', async () => {
    const { code } = await run(['init', '--yes', '--update-time', '03:30', '--update-tz', 'UTC']);
    expect(code).toBe(0);
    const env = readEnv();
    expect(env.KORTIX_UPDATE_TIME).toBe('03:30');
    expect(env.KORTIX_UPDATE_TZ).toBe('UTC');
  });

  test('rejects an invalid --update-time value', async () => {
    const { code, stderr } = await run(['init', '--yes', '--update-time', '9pm']);
    expect(code).toBe(2);
    expect(stderr).toContain('--update-time must be HH:MM');
  });

  // There is deliberately no `--allow-downtime` flag: KORTIX_ALLOW_DOWNTIME is
  // env-only — a release that needs a brief downtime window says so, and the
  // operator sets it directly (`env set KORTIX_ALLOW_DOWNTIME=1`).
  test('KORTIX_ALLOW_DOWNTIME defaults off and is set directly via env set', async () => {
    await run(['init', '--yes']);
    expect(readEnv().KORTIX_ALLOW_DOWNTIME).toBe('0');
    const { code } = await run(['env', 'set', 'KORTIX_ALLOW_DOWNTIME=1']);
    expect(code).toBe(0);
    expect(readEnv().KORTIX_ALLOW_DOWNTIME).toBe('1');
    // A later plain re-init must not reset it.
    const reinit = await run(['init', '--yes']);
    expect(reinit.code).toBe(0);
    expect(readEnv().KORTIX_ALLOW_DOWNTIME).toBe('1');
  });

  test('KORTIX_APP_REPLICAS flips to 2 once a domain is configured, back to 1 without one', async () => {
    await run(['init', '--yes']);
    expect(readEnv().KORTIX_APP_REPLICAS).toBe('1');

    await run(['env', 'set', 'KORTIX_DOMAIN=kortix.example.com']);
    expect(readEnv().KORTIX_APP_REPLICAS).toBe('2');

    await run(['env', 'set', 'KORTIX_DOMAIN=']);
    expect(readEnv().KORTIX_APP_REPLICAS).toBe('1');
  });

  test('KORTIX_INSTANCE_DIR is the absolute instance directory and is wired into the rendered kortix-updater service (DinD self-referential mount)', async () => {
    // Regression coverage for the "mounts denied" self-host update bug: the
    // in-compose kortix-updater runs `docker compose` against the HOST daemon
    // over the mounted socket, so any relative bind mount elsewhere in this
    // compose file only resolves correctly if the updater container sees the
    // instance directory at the SAME absolute path the host does. That path
    // is KORTIX_INSTANCE_DIR — recomputed from the real on-disk instance dir
    // on every render (see normalizeFullSupabaseEnv in commands/self-host.ts).
    await run(['init', '--yes']);
    const instanceDir = join(configRoot, 'default');
    expect(readEnv().KORTIX_INSTANCE_DIR).toBe(instanceDir);

    const compose = readCompose() as { services: Record<string, {
      volumes?: string[];
      working_dir?: string;
    }> };
    const updater = compose.services['kortix-updater'];
    expect(updater?.working_dir).toBe('${KORTIX_INSTANCE_DIR}');
    expect(updater?.volumes).toContain('${KORTIX_INSTANCE_DIR}:${KORTIX_INSTANCE_DIR}');
  });

  test('the rendered compose has no Caddy service until KORTIX_DOMAIN is set', async () => {
    await run(['init', '--yes']);
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

  describe('configuration feature flags (landing / enterprise-license / billing)', () => {
    test('default to off (except the landing page, off by default too), and are explicit in .env (not just hard-coded in the compose template)', async () => {
      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      const env = readEnv();
      // Self-host is an app deployment, not a marketing site — the marketing
      // landing page is DISABLED by default (unlike Kortix Cloud).
      expect(env.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
      expect(env.ENTERPRISE_LICENSE_AVAILABLE).toBe('false');
      expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('false');
      expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('false');
    });

    // Account-creation restriction is the one feature flag that defaults ON
    // for self-host (every other flag in this describe block defaults off) —
    // a VPS operator usually wants to be the only one who can spin up new
    // organizations on their own instance.
    test('account-creation restriction defaults ON (both the api and frontend-mirroring vars)', async () => {
      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_RESTRICT_ACCOUNT_CREATION).toBe('true');
      expect(env.KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION).toBe('true');
    });

    test('--no-restrict-account-creation opts out of the default (both vars)', async () => {
      const { code } = await run(['init', '--yes', '--no-restrict-account-creation']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_RESTRICT_ACCOUNT_CREATION).toBe('false');
      expect(env.KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION).toBe('false');
    });

    test('--restrict-account-creation and --no-restrict-account-creation together is a usage error', async () => {
      const { code, stderr } = await run([
        'init',
        '--yes',
        '--restrict-account-creation',
        '--no-restrict-account-creation',
      ]);
      expect(code).not.toBe(0);
      expect(stderr).toContain('mutually exclusive');
    });

    test('a re-run of init without the flag does not reset a previously opted-out account-creation restriction', async () => {
      await run(['init', '--yes', '--no-restrict-account-creation']);
      expect(readEnv().KORTIX_RESTRICT_ACCOUNT_CREATION).toBe('false');

      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      expect(readEnv().KORTIX_RESTRICT_ACCOUNT_CREATION).toBe('false');
      expect(readEnv().KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION).toBe('false');
    });

    // There is deliberately no `--landing`/`--no-landing` flag: the landing
    // page isn't a guided-flow decision (self-host is an app deployment, not
    // a marketing site — full stop), it's just an ordinary env var an
    // operator can flip directly if they genuinely want it back.
    test('re-enabling the landing page is a plain `env set`, no dedicated flag', async () => {
      await run(['init', '--yes']);
      expect(readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');

      const { code } = await run(['env', 'set', 'KORTIX_PUBLIC_DISABLE_LANDING_PAGE=false']);
      expect(code).toBe(0);
      expect(readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('false');

      // A later plain re-init must not silently flip it back off.
      const reinit = await run(['init', '--yes']);
      expect(reinit.code).toBe(0);
      expect(readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('false');
    });

    test('--enterprise-license sets ENTERPRISE_LICENSE_AVAILABLE', async () => {
      const { code } = await run(['init', '--yes', '--enterprise-license']);
      expect(code).toBe(0);
      expect(readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
    });

    test('a re-run of init without the flag does not reset a previously-set flag', async () => {
      await run(['init', '--yes', '--enterprise-license']);
      expect(readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');

      // Plain re-init (e.g. a config refresh) must not silently turn it back off.
      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      expect(readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
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
      await run(['init', '--yes']);
      await run(['env', 'set', 'KORTIX_BILLING_INTERNAL_ENABLED=true', 'KORTIX_PUBLIC_BILLING_ENABLED=true']);
      expect(readEnv().KORTIX_BILLING_INTERNAL_ENABLED).toBe('true');

      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('true');
      expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('true');
    });

    test('the rendered compose passes the flags through as runtime env, not hard-coded literals', async () => {
      await run(['init', '--yes']);
      const compose = readCompose();
      const frontendEnv = (compose.services.frontend as any).environment;
      expect(frontendEnv.KORTIX_PUBLIC_BILLING_ENABLED).toBe('${KORTIX_PUBLIC_BILLING_ENABLED}');
      expect(frontendEnv.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('${KORTIX_PUBLIC_DISABLE_LANDING_PAGE}');
      expect(frontendEnv.KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION).toBe('${KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION}');

      // kortix-api gets these via `env_file: .env` (loads every .env key) —
      // no explicit `environment:` entry, since one would win over env_file
      // and re-introduce the old "billing hard-pinned false" bug.
      const apiEnv = (compose.services['kortix-api'] as any).environment;
      expect(apiEnv.KORTIX_BILLING_INTERNAL_ENABLED).toBeUndefined();
      expect(apiEnv.ENTERPRISE_LICENSE_AVAILABLE).toBeUndefined();
      expect(apiEnv.KORTIX_RESTRICT_ACCOUNT_CREATION).toBeUndefined();
      expect((compose.services['kortix-api'] as any).env_file).toContain('.env');
    });
  });

  describe('reachability (KORTIX_URL, --domain, --tunnel)', () => {
    test('the rendered compose templates KORTIX_URL instead of hard-coding the internal Docker hostname', async () => {
      await run(['init', '--yes']);
      const compose = readCompose();
      const apiEnv = (compose.services['kortix-api'] as any).environment;
      expect(apiEnv.KORTIX_URL).toBe('${KORTIX_URL}');
      expect(apiEnv.KORTIX_URL).not.toContain('kortix-api:8008');
    });

    test('default (local-only) mode: KORTIX_URL mirrors the loopback API_PUBLIC_URL, not the internal hostname', async () => {
      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      const env = readEnv();
      expect(env.KORTIX_URL).toBe(env.API_PUBLIC_URL);
      expect(env.KORTIX_URL).toStartWith('http://localhost:');
      expect(env.KORTIX_REACHABILITY_MODE).toBe('local');
      expect(readCompose().services).not.toHaveProperty('cloudflared');
    });

    test('--domain sets KORTIX_DOMAIN and KORTIX_URL follows API_PUBLIC_URL (https://api.<domain>)', async () => {
      const { code } = await run(['init', '--yes', '--domain', 'kortix.example.com']);
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
      await run(['init', '--yes', '--domain', 'kortix.example.com']);
      expect(readEnv().KORTIX_DOMAIN).toBe('kortix.example.com');

      // The `--flag=value` form (not `--flag value`) is required to pass an
      // explicit empty string — takeFlagValue treats a bare falsy next-arg as
      // "no value provided" and errors, but `--domain=` with nothing after
      // the `=` is unambiguous.
      const { code } = await run(['init', '--yes', '--domain=']);
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
      const { code } = await run(['init', '--yes', '--tunnel', 'cloudflare']);
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
      await run(['init', '--yes', '--tunnel', 'cloudflare']);
      const { code } = await run(['init', '--yes']);
      expect(code).toBe(0);
      expect(readEnv().KORTIX_REACHABILITY_MODE).toBe('tunnel');
      expect(readCompose().services).toHaveProperty('cloudflared');
    });

    test('rejects an unsupported --tunnel provider', async () => {
      const { code, stderr } = await run(['init', '--yes', '--tunnel', 'ngrok']);
      expect(code).not.toBe(0);
      expect(stderr).toContain('cloudflare');
    });

    test('a named tunnel (token + hostname) can be configured via env set, restarting only cloudflared when active', async () => {
      await run(['init', '--yes', '--tunnel', 'cloudflare']);
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

    test('setting CLOUDFLARE_TUNNEL_TOKEN via env set before tunnel mode is selected does not error (stack not running)', async () => {
      await run(['init', '--yes']);
      const { code } = await run(['env', 'set', 'CLOUDFLARE_TUNNEL_TOKEN=faketoken']);
      expect(code).toBe(0);
    });
  });

  test('help shows the grant-platform-admin-later env set example', async () => {
    // The guided flows (init once, configure always) ask for the admin email,
    // but an operator who declined both needs a discoverable non-interactive
    // path — the help example is that path.
    const { code, stdout } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('env set KORTIX_PLATFORM_ADMIN_EMAILS=');
  });

  test('doctor flags a stale KORTIX_INSTANCE_DIR (instance directory moved since the last render) and passes it fresh otherwise', async () => {
    await run(['init', '--yes']);

    const fresh = await run(['doctor', '--json']);
    const freshCheck = (JSON.parse(fresh.stdout).checks as Array<{ name: string; ok: boolean }>)
      .find((c) => c.name === 'instance-dir');
    expect(freshCheck?.ok).toBe(true);

    // Simulate the instance directory having moved on disk (or
    // KORTIX_SELF_HOST_CONFIG_DIR having changed) since the last
    // init/start/update/configure/env-set render — hand-edit .env the way
    // `env set` itself refuses to (see secrets.test.ts's updater-managed
    // refusal coverage for KORTIX_INSTANCE_DIR).
    const envFile = join(configRoot, 'default', '.env');
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(
        /^KORTIX_INSTANCE_DIR=.*$/m,
        'KORTIX_INSTANCE_DIR=/tmp/stale-path-from-before-a-move',
      ),
    );

    const stale = await run(['doctor', '--json']);
    const staleCheck = (JSON.parse(stale.stdout).checks as Array<{ name: string; ok: boolean; detail: string }>)
      .find((c) => c.name === 'instance-dir');
    expect(staleCheck?.ok).toBe(false);
    expect(staleCheck?.detail).toContain('stale');
  });

  // `connect-github` is deprecated: managed git is now configured in the web
  // dashboard (Settings → Git), not by this CLI — the App-manifest flow it
  // used to run never worked reliably from a laptop (GitHub rejects
  // hook/callback URLs unreachable over the public internet). The dispatch
  // case is kept as a no-op alias (not removed outright) so a script that
  // still calls it doesn't hard-fail.
  test('connect-github is a deprecated no-op alias: exits 0 and points at the dashboard instead of running the App-manifest flow', async () => {
    await run(['init', '--yes']);
    const { code, stdout } = await run(['connect-github']);
    expect(code).toBe(0);
    expect(stdout).toContain('deprecated');
    expect(stdout.toLowerCase()).toContain('settings');
  });
});
