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

  test('--allow-downtime sets KORTIX_ALLOW_DOWNTIME=1', async () => {
    await run(['init', '--yes']);
    expect(readEnv().KORTIX_ALLOW_DOWNTIME).toBe('0');
    const { code } = await run(['init', '--yes', '--allow-downtime']);
    expect(code).toBe(0);
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
});
