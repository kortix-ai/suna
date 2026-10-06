import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `kortix triggers info` for webhook triggers, as a real process: the output
 * must carry the signing scheme (header, algorithm, sample request) a
 * CLI/API-only caller needs to fire the webhook — the same scheme the
 * dashboard's Sample request panel renders.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'info_project';
const WEBHOOK_URL = 'https://api.kortix.test/v1/webhooks/projects/proj_hook/release-hook';

let tmp: string;
let config: string;
let server: ReturnType<typeof Bun.serve> | null = null;

const WEBHOOK_TRIGGER = {
  slug: 'release-hook',
  path: 'kortix.yaml#triggers.release-hook',
  name: 'Release hook',
  type: 'webhook',
  agent: 'releaser',
  model: null,
  enabled: true,
  cron: null,
  run_at: null,
  timezone: 'UTC',
  secret_env: 'RELEASE_HOOK_SECRET',
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  prompt_template: 'A release webhook arrived: {{ body.event }}',
  session_mode: 'reuse',
  session_id: null,
  session_key: null,
  filter: null,
  last_fired_at: null,
  webhook_url: WEBHOOK_URL,
};

const CRON_TRIGGER = {
  ...WEBHOOK_TRIGGER,
  slug: 'nightly',
  name: 'Nightly digest',
  type: 'cron',
  agent: 'default',
  secret_env: null,
  cron: '0 0 9 * * 1-5',
  prompt_template: 'Summarize yesterday',
  webhook_url: null,
};

function writeConfig(apiBase: string): string {
  const path = join(tmp, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: apiBase,
          token: 'tok_triggers',
          user_id: 'user_1',
          user_email: 'user@example.test',
          account_id: 'account_1',
          logged_in_at: '2026-01-01T00:00:00.000Z',
        },
      },
    }),
    'utf8',
  );
  return path;
}

function startServer(triggers: unknown[]): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      if (pathname.endsWith('/triggers')) {
        return Response.json({ triggers, errors: [], triggers_paused: false });
      }
      return Response.json({});
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

function writeManifest(): void {
  writeFileSync(
    join(tmp, 'kortix.yaml'),
    ['kortix_version: 2', 'name: triggers-info-test', 'default_agent: default', ''].join('\n'),
    'utf8',
  );
}

async function runCli(args: string[], configFile: string = config) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    // Always a throwaway config — never the developer's real ~/.kortix.
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).finally(() => clearTimeout(timeout));
  return { code, stdout, stderr };
}

describe('kortix triggers info — webhook signing', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-info-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    config = writeConfig('http://127.0.0.1:1');
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('info shows the signing header, the algorithm and a signed sample request', async () => {
    const apiConfig = writeConfig(startServer([WEBHOOK_TRIGGER]));
    const result = await runCli(
      ['triggers', 'info', 'release-hook', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('X-Kortix-Signature');
    expect(result.stdout).toContain('HMAC-SHA256');
    expect(result.stdout).toContain(`curl -X POST ${WEBHOOK_URL}`);
    expect(result.stdout).toContain('openssl dgst -sha256 -hmac "$SECRET"');
    // The scheme is signed with the caller's own secret (the $SECRET
    // placeholder), like the dashboard panel — never a secret value.
    expect(result.stdout).toContain('$SECRET is the signing key you saved for this webhook');
  });

  test('info --json carries the signing scheme a caller can act on', async () => {
    const apiConfig = writeConfig(startServer([WEBHOOK_TRIGGER]));
    const result = await runCli(
      ['triggers', 'info', 'release-hook', '--project', PROJECT, '--json'],
      apiConfig,
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.webhook_signing).toEqual({
      header: 'X-Kortix-Signature',
      algorithm: 'HMAC-SHA256 over the exact raw request body',
      sample_request: expect.stringContaining(`curl -X POST ${WEBHOOK_URL}`),
    });
    expect(parsed.webhook_signing.sample_request).toContain('X-Kortix-Signature: sha256=');
  });

  test('a cron trigger carries no signing metadata', async () => {
    const apiConfig = writeConfig(startServer([CRON_TRIGGER]));
    const result = await runCli(
      ['triggers', 'info', 'nightly', '--project', PROJECT, '--json'],
      apiConfig,
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.webhook_signing).toBeUndefined();
    const text = await runCli(['triggers', 'info', 'nightly', '--project', PROJECT], apiConfig);
    expect(text.stdout).not.toContain('X-Kortix-Signature');
  });
});
