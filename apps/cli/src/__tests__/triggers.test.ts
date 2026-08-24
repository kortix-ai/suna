import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `kortix triggers` as a real process, for the third trigger type
 * (docs/specs/2026-08-12-monitors.md). `add` edits the LOCAL kortix.yaml, so
 * those cases assert the file on disk; `ls`/`info` read the cloud, so those
 * cases assert the rendering of a served listing.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'monitors_project';

let tmp: string;
let config: string;
let server: ReturnType<typeof Bun.serve> | null = null;

const MONITOR_TRIGGER = {
  slug: 'checkout-errors',
  path: 'kortix.yaml#triggers.checkout-errors',
  name: 'Checkout errors',
  type: 'monitor',
  agent: 'oncall',
  model: null,
  enabled: true,
  cron: null,
  run_at: null,
  timezone: 'UTC',
  secret_env: null,
  run: './monitors/checkout-errors.ts',
  mode: 'poll',
  interval_seconds: 60,
  expect_event_within_seconds: 86400,
  prompt_template: 'Checkout monitor emitted: {{ line }}',
  session_mode: 'reuse',
  session_id: null,
  session_key: null,
  filter: null,
  last_fired_at: null,
  webhook_url: null,
};

const STREAM_TRIGGER = {
  ...MONITOR_TRIGGER,
  slug: 'log-tail',
  name: 'Log tail',
  run: './monitors/log-tail.ts',
  mode: 'stream',
  interval_seconds: null,
  expect_event_within_seconds: null,
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
    ['kortix_version: 2', 'name: monitors-test', 'default_agent: default', ''].join('\n'),
    'utf8',
  );
}

function manifestText(): string {
  return readFileSync(join(tmp, 'kortix.yaml'), 'utf8');
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
    'KORTIX_TOKEN',
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

describe('kortix triggers — monitors', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    // Local-only subcommands (`add`) never call the API, but the CLI still
    // resolves a host for its banner — point it at a dead port.
    config = writeConfig('http://127.0.0.1:1');
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('help documents the monitor type and its flags', async () => {
    const result = await runCli(['triggers', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('monitor');
    expect(result.stdout).toContain('--run <cmd>');
    expect(result.stdout).toContain('--mode <poll|stream>');
    expect(result.stdout).toContain('--interval');
    expect(result.stdout).toContain('--expect-event-within');
  });

  test('add writes a poll monitor block to kortix.yaml', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'checkout-errors',
      '--type',
      'monitor',
      '--run',
      './monitors/checkout-errors.ts',
      '--mode',
      'poll',
      '--interval',
      '60s',
      '--expect-event-within',
      '24h',
      '--agent',
      'oncall',
      '--prompt',
      'Checkout monitor emitted: {{ line }}',
    ]);
    expect(result.stderr).not.toMatch(/must be|is required|not valid/);
    expect(result.code).toBe(0);

    const text = manifestText();
    expect(text).toContain('slug: checkout-errors');
    expect(text).toContain('type: monitor');
    expect(text).toContain('run: ./monitors/checkout-errors.ts');
    expect(text).toContain('mode: poll');
    // Durations are re-emitted in canonical form, exactly like the API's own
    // write path (`formatDurationSeconds`): 60s -> 1m, 24h -> 1d.
    expect(text).toContain('interval: 1m');
    expect(text).toContain('expect_event_within: 1d');
    expect(text).toContain('agent: oncall');
    // cron/webhook wiring must never appear on a monitor.
    expect(text).not.toContain('cron:');
    expect(text).not.toContain('timezone:');
    expect(text).not.toContain('secret_env:');
    expect(result.stdout).toContain('kortix ship');
  });

  test('add writes a stream monitor with no interval', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'log-tail',
      '--type',
      'monitor',
      '--run',
      './monitors/log-tail.ts',
      '--mode',
      'stream',
      '--prompt',
      'Log line: {{ line }}',
    ]);
    expect(result.code).toBe(0);
    const text = manifestText();
    expect(text).toContain('mode: stream');
    expect(text).not.toContain('interval:');
  });

  test('add rejects a monitor with no --run', async () => {
    const result = await runCli([
      'triggers', 'add', 'no-run', '--type', 'monitor', '--mode', 'poll',
      '--interval', '60s', '--prompt', 'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--run');
    expect(manifestText()).not.toContain('no-run');
  });

  test('add rejects a monitor with an unknown --mode', async () => {
    const result = await runCli([
      'triggers', 'add', 'bad-mode', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'tail', '--prompt', 'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('poll');
    expect(result.stderr).toContain('stream');
  });

  test('add rejects a poll monitor with no --interval', async () => {
    const result = await runCli([
      'triggers', 'add', 'no-interval', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'poll', '--prompt', 'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('interval');
  });

  test('add rejects --interval on a stream monitor', async () => {
    const result = await runCli([
      'triggers', 'add', 'stream-interval', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'stream', '--interval', '60s', '--prompt', 'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('poll');
  });

  test('add enforces the platform duration floors', async () => {
    const shortInterval = await runCli([
      'triggers', 'add', 'fast-poll', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'poll', '--interval', '10s', '--prompt', 'x',
    ]);
    expect(shortInterval.code).toBe(2);
    expect(shortInterval.stderr).toContain('30s');

    const shortWatchdog = await runCli([
      'triggers', 'add', 'twitchy', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'poll', '--interval', '60s', '--expect-event-within', '1m', '--prompt', 'x',
    ]);
    expect(shortWatchdog.code).toBe(2);
    expect(shortWatchdog.stderr).toContain('5m');
  });

  test('add rejects a bare number where a duration literal is required', async () => {
    const result = await runCli([
      'triggers', 'add', 'bare-number', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'poll', '--interval', '60', '--prompt', 'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('30s');
  });

  test('add rejects cron/webhook flags on a monitor', async () => {
    const withCron = await runCli([
      'triggers', 'add', 'cron-monitor', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'stream', '--cron', '0 0 9 * * 1-5', '--prompt', 'x',
    ]);
    expect(withCron.code).toBe(2);
    expect(withCron.stderr).toContain('monitor');

    const withSecret = await runCli([
      'triggers', 'add', 'secret-monitor', '--type', 'monitor', '--run', './m.ts',
      '--mode', 'stream', '--secret-env', 'HOOK', '--prompt', 'x',
    ]);
    expect(withSecret.code).toBe(2);
    expect(withSecret.stderr).toContain('monitor');
  });

  test('add rejects monitor flags on a cron trigger', async () => {
    const result = await runCli([
      'triggers', 'add', 'cron-with-run', '--type', 'cron', '--cron', '0 0 9 * * 1-5',
      '--run', './m.ts', '--prompt', 'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('monitor');
  });

  test('ls renders a monitor row with its mode and interval, not a schedule', async () => {
    const apiConfig = writeConfig(startServer([MONITOR_TRIGGER, STREAM_TRIGGER]));
    const result = await runCli(['triggers', 'ls', '--project', PROJECT], apiConfig);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('checkout-errors');
    expect(result.stdout).toContain('monitor');
    expect(result.stdout).toContain('poll 1m');
    expect(result.stdout).toContain('stream');
    expect(result.stdout).not.toContain('secret_env=');
  });

  test('info shows the monitor fields', async () => {
    const apiConfig = writeConfig(startServer([MONITOR_TRIGGER]));
    const result = await runCli(
      ['triggers', 'info', 'checkout-errors', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('monitor');
    expect(result.stdout).toContain('./monitors/checkout-errors.ts');
    expect(result.stdout).toContain('poll');
    expect(result.stdout).toContain('1m');
    expect(result.stdout).toContain('1d');
    // A monitor has no schedule and no webhook secret to show.
    expect(result.stdout).not.toContain('timezone');
    expect(result.stdout).not.toContain('secret_env');
  });

  test('info --json emits the monitor fields verbatim', async () => {
    const apiConfig = writeConfig(startServer([MONITOR_TRIGGER]));
    const result = await runCli(
      ['triggers', 'info', 'checkout-errors', '--project', PROJECT, '--json'],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      type: 'monitor',
      run: './monitors/checkout-errors.ts',
      mode: 'poll',
      interval_seconds: 60,
      expect_event_within_seconds: 86400,
    });
  });

  test('cron and webhook adds are unchanged', async () => {
    const cron = await runCli([
      'triggers', 'add', 'daily-digest', '--type', 'cron', '--cron', '0 0 9 * * 1-5',
      '--timezone', 'America/Los_Angeles', '--prompt', 'Summarize yesterday.',
    ]);
    expect(cron.code).toBe(0);
    const hook = await runCli([
      'triggers', 'add', 'new-lead', '--type', 'webhook', '--secret-env', 'WEBHOOK_SECRET',
      '--prompt', 'A new lead arrived.',
    ]);
    expect(hook.code).toBe(0);

    const text = manifestText();
    expect(text).toContain('cron: 0 0 9 * * 1-5');
    expect(text).toContain('timezone: America/Los_Angeles');
    expect(text).toContain('secret_env: WEBHOOK_SECRET');
    expect(text).not.toContain('mode:');
    expect(text).not.toContain('run:');
  });
});
