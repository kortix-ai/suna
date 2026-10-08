import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `kortix triggers` as a real process, for the third trigger type and the
 * webhook trigger's info panel.
 * `add` edits the LOCAL kortix.yaml, so
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
  event: null,
};

const WEBHOOK_TRIGGER = {
  ...MONITOR_TRIGGER,
  slug: 'release-hook',
  path: 'kortix.yaml#triggers.release-hook',
  name: 'Release hook',
  type: 'webhook',
  agent: 'releaser',
  secret_env: 'RELEASE_HOOK_SECRET',
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  prompt_template: 'A release webhook arrived: {{ body.event }}',
  webhook_url: 'https://api.kortix.test/v1/webhooks/projects/proj_hook/release-hook',
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

const EVENT_TRIGGER = {
  ...MONITOR_TRIGGER,
  slug: 'new-pr',
  path: 'kortix.yaml#triggers.new-pr',
  name: 'New pull request',
  type: 'event',
  agent: 'reviewer',
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  prompt_template: 'Review {{ event.data.title }}',
  event: {
    connector: 'github',
    type: 'GITHUB_PULL_REQUEST_EVENT',
    config: { owner: 'acme', repo: 'app' },
    provider: 'composio',
    app: 'github',
    status: 'needs_connection',
    error: 'No connected account',
    last_event_at: null,
  },
};

const EVENT_TYPES = {
  provider: 'composio',
  app: 'github',
  event_types: [
    {
      type: 'GITHUB_PULL_REQUEST_EVENT',
      name: 'Pull request',
      description: 'A pull request is opened',
      app: 'github',
      delivery: 'poll',
      config_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', examples: ['app'] },
          limit: { type: 'integer', default: 30 },
        },
        required: ['owner'],
      },
      payload_schema: { type: 'object', properties: { title: { type: 'string', description: 'PR title' } } },
    },
  ],
};

const EVENT_APPS = {
  apps: [
    {
      provider: 'composio', app: 'github', name: 'GitHub', logo: null, event_count: 12, connector: 'github', connected: true,
      connectors: [
        { slug: 'github', name: 'GitHub', accounts: [
          { label: 'acme-bot', connected_as: 'acme-bot-user', is_default: true, connected: true },
          { label: 'acme-ci', connected_as: null, is_default: false, connected: true },
        ] },
        { slug: 'github-work', name: 'GitHub work', accounts: [] },
      ],
    },
    { provider: 'composio', app: 'gmail', name: 'Gmail', logo: null, event_count: 3, connector: 'gmail', connected: false },
    { provider: 'composio', app: 'linear', name: 'Linear', logo: null, event_count: 5, connector: null, connected: false },
  ],
};

function startServer(triggers: unknown[]): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      if (pathname.endsWith('/triggers/event-apps')) return Response.json(EVENT_APPS);
      if (pathname.endsWith('/triggers/event-types')) {
        return Response.json(EVENT_TYPES);
      }
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
      'triggers',
      'add',
      'no-run',
      '--type',
      'monitor',
      '--mode',
      'poll',
      '--interval',
      '60s',
      '--prompt',
      'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--run');
    expect(manifestText()).not.toContain('no-run');
  });

  test('add rejects a monitor with an unknown --mode', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'bad-mode',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'tail',
      '--prompt',
      'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('poll');
    expect(result.stderr).toContain('stream');
  });

  test('add rejects a poll monitor with no --interval', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'no-interval',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'poll',
      '--prompt',
      'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('interval');
  });

  test('add rejects --interval on a stream monitor', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'stream-interval',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'stream',
      '--interval',
      '60s',
      '--prompt',
      'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('poll');
  });

  test('add enforces the platform duration floors', async () => {
    const shortInterval = await runCli([
      'triggers',
      'add',
      'fast-poll',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'poll',
      '--interval',
      '10s',
      '--prompt',
      'x',
    ]);
    expect(shortInterval.code).toBe(2);
    expect(shortInterval.stderr).toContain('30s');

    const shortWatchdog = await runCli([
      'triggers',
      'add',
      'twitchy',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'poll',
      '--interval',
      '60s',
      '--expect-event-within',
      '1m',
      '--prompt',
      'x',
    ]);
    expect(shortWatchdog.code).toBe(2);
    expect(shortWatchdog.stderr).toContain('5m');
  });

  test('add rejects a bare number where a duration literal is required', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'bare-number',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'poll',
      '--interval',
      '60',
      '--prompt',
      'x',
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('30s');
  });

  test('add rejects cron/webhook flags on a monitor', async () => {
    const withCron = await runCli([
      'triggers',
      'add',
      'cron-monitor',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'stream',
      '--cron',
      '0 0 9 * * 1-5',
      '--prompt',
      'x',
    ]);
    expect(withCron.code).toBe(2);
    expect(withCron.stderr).toContain('monitor');

    const withSecret = await runCli([
      'triggers',
      'add',
      'secret-monitor',
      '--type',
      'monitor',
      '--run',
      './m.ts',
      '--mode',
      'stream',
      '--secret-env',
      'HOOK',
      '--prompt',
      'x',
    ]);
    expect(withSecret.code).toBe(2);
    expect(withSecret.stderr).toContain('monitor');
  });

  test('add rejects monitor flags on a cron trigger', async () => {
    const result = await runCli([
      'triggers',
      'add',
      'cron-with-run',
      '--type',
      'cron',
      '--cron',
      '0 0 9 * * 1-5',
      '--run',
      './m.ts',
      '--prompt',
      'x',
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

  test('subcommand --help prints usage and exits 0 (splitHelp)', async () => {
    for (const args of [['--help'], ['ls', '--help'], ['add', 'x', '-h'], ['rm', 'x', '--help']]) {
      const result = await runCli(['triggers', ...args]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Usage: kortix triggers');
      expect(result.stderr).not.toContain('unknown subcommand');
    }
  });

  test('a missing slug is the shared arg error: exit 2, no HTTP call', async () => {
    for (const args of [['add'], ['rm'], ['fire'], ['enable'], ['disable'], ['info']]) {
      const result = await runCli(['triggers', ...args]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Pass a trigger slug.');
    }
    expect(manifestText()).not.toContain('slug:');
  });

  test('rm of an unknown local slug exits 1 with the manifest error', async () => {
    const result = await runCli(['triggers', 'rm', 'nope']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No [[triggers]] "nope" in kortix.yaml.');
  });

  test('cron and webhook adds are unchanged', async () => {
    const cron = await runCli([
      'triggers',
      'add',
      'daily-digest',
      '--type',
      'cron',
      '--cron',
      '0 0 9 * * 1-5',
      '--timezone',
      'America/Los_Angeles',
      '--prompt',
      'Summarize yesterday.',
    ]);
    expect(cron.code).toBe(0);
    const hook = await runCli([
      'triggers',
      'add',
      'new-lead',
      '--type',
      'webhook',
      '--secret-env',
      'WEBHOOK_SECRET',
      '--prompt',
      'A new lead arrived.',
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

/**
 * `kortix triggers fire` reports the RUN's outcome, not just the fire's.
 * A fire that the API accepts can still end in a failed run; the runtime row
 * (`last_status`/`last_error`) records that outcome, so fire waits for it and
 * exits non-zero with the real error.
 */
describe('kortix triggers fire — reports the run outcome', () => {
  const SESSION_ID = 'b3f0c2a1-0000-4000-8000-000000000001';
  const FAILURE_TEXT = 'Payment Required: Insufficient credits. Balance: $-0.06';

  interface FireState {
    triggers: Record<string, unknown>[];
    /** The fire response's status and session id. */
    fireStatus: 'fired' | 'queued';
    /** GET of the fired session: 200 while this is set, 404 when null. */
    session: Record<string, unknown> | null;
    /** Flip the trigger row to failed this long after the fire POST. */
    failAfterMs: number | null;
    deletedSessions: string[];
  }

  let state: FireState;

  function cronTrigger(): Record<string, unknown> {
    return {
      slug: 'dogfood-cron',
      path: 'kortix.yaml#triggers.dogfood-cron',
      name: 'dogfood-cron',
      type: 'cron',
      agent: 'default',
      model: null,
      enabled: true,
      cron: '0 0 9 * * *',
      run_at: null,
      timezone: 'UTC',
      secret_env: null,
      run: null,
      mode: null,
      interval_seconds: null,
      expect_event_within_seconds: null,
      prompt_template: 'Reply pong',
      session_mode: 'fresh',
      session_id: null,
      session_key: null,
      filter: null,
      last_fired_at: null,
      last_status: null,
      last_error: null,
      last_attempt_at: null,
      webhook_url: null,
    };
  }

  function startFireServer(opts: { triggersEndpoint?: 'down' } = {}): string {
    const base = `/v1/projects/${PROJECT}/triggers`;
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (opts.triggersEndpoint === 'down' && url.pathname === base && req.method === 'GET') {
          return Response.json({ error: 'database unavailable' }, { status: 503 });
        }
        if (url.pathname === `${base}/dogfood-cron/fire` && req.method === 'POST') {
          const now = new Date().toISOString();
          // The fire route's own write: last_status fired, last_attempt_at set.
          state.triggers = state.triggers.map((t) =>
            t.slug === 'dogfood-cron'
              ? { ...t, last_status: 'fired', last_error: null, last_attempt_at: now }
              : t,
          );
          if (state.failAfterMs !== null) {
            setTimeout(() => {
              state.triggers = state.triggers.map((t) =>
                t.slug === 'dogfood-cron'
                  ? {
                      ...t,
                      last_status: 'failed',
                      last_error: FAILURE_TEXT,
                      last_attempt_at: new Date().toISOString(),
                    }
                  : t,
              );
            }, state.failAfterMs);
          }
          return Response.json(
            {
              status: state.fireStatus,
              session_id: state.fireStatus === 'fired' ? SESSION_ID : null,
              command_id: null,
              deduped: false,
            },
            { status: 202 },
          );
        }
        if (url.pathname === base && req.method === 'GET') {
          return Response.json({ triggers: state.triggers, triggers_paused: false, errors: [] });
        }
        if (url.pathname === `/v1/projects/${PROJECT}/sessions/${SESSION_ID}`) {
          if (req.method === 'GET') {
            if (!state.session) return Response.json({ error: 'Not found' }, { status: 404 });
            return Response.json(state.session);
          }
          if (req.method === 'DELETE') {
            state.deletedSessions.push(SESSION_ID);
            return Response.json({ ok: true });
          }
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-fire-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    state = {
      triggers: [cronTrigger()],
      fireStatus: 'fired',
      session: {
        session_id: SESSION_ID,
        status: 'running',
        error: null,
        name: null,
        agent_name: 'default',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      failAfterMs: null,
      deletedSessions: [],
    };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('a failed run exits non-zero with the real error and cleans up the session', async () => {
    state.failAfterMs = 300;
    const apiConfig = writeConfig(startFireServer());
    const result = await runCli(
      ['triggers', 'fire', 'dogfood-cron', '--wait', '8s', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(FAILURE_TEXT);
    // The failed run's fresh session is cleaned up, so its per-session API key
    // does not outlive the run.
    expect(state.deletedSessions).toEqual([SESSION_ID]);
  });

  test('a run with no failure inside the window exits 0 with the session id', async () => {
    const apiConfig = writeConfig(startFireServer());
    const result = await runCli(
      ['triggers', 'fire', 'dogfood-cron', '--wait', '1s', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(SESSION_ID);
    expect(result.stdout).toContain('no failure');
    expect(state.deletedSessions).toEqual([]);
  });

  test('--wait 0 keeps the old fire-and-return behavior', async () => {
    state.failAfterMs = 100;
    const apiConfig = writeConfig(startFireServer());
    const result = await runCli(
      ['triggers', 'fire', 'dogfood-cron', '--wait', '0', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(SESSION_ID);
    expect(state.deletedSessions).toEqual([]);
  });

  test('an unreadable trigger row is reported as unwatched, never as no failure', async () => {
    const apiConfig = writeConfig(startFireServer({ triggersEndpoint: 'down' }));
    const result = await runCli(
      ['triggers', 'fire', 'dogfood-cron', '--wait', '2s', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(SESSION_ID);
    expect(result.stdout).toContain('could not watch');
    expect(result.stdout).not.toContain('no failure');
  });

  test('a fired session the caller cannot read exits non-zero', async () => {
    state.session = null;
    const apiConfig = writeConfig(startFireServer());
    const result = await runCli(
      ['triggers', 'fire', 'dogfood-cron', '--wait', '1s', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(SESSION_ID);
    expect(result.stdout).not.toContain('Fired');
  });

  test('a queued fire whose run later fails exits non-zero with the error', async () => {
    state.fireStatus = 'queued';
    state.failAfterMs = 300;
    const apiConfig = writeConfig(startFireServer());
    const result = await runCli(
      ['triggers', 'fire', 'dogfood-cron', '--wait', '8s', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(FAILURE_TEXT);
    expect(state.deletedSessions).toEqual([]);
  });
});

describe('kortix triggers info — webhook signing', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-'));
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
    expect(result.stdout).toContain(`curl -X POST ${WEBHOOK_TRIGGER.webhook_url}`);
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
      sample_request: expect.stringContaining(`curl -X POST ${WEBHOOK_TRIGGER.webhook_url}`),
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

describe('kortix triggers — events', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-'));
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

  const add = (...extra: string[]) =>
    runCli(['triggers', 'add', 'new-pr', '--type', 'event', '--prompt', 'Review {{ event.data.title }}', ...extra]);

  test('help documents the event type and its flags', async () => {
    const result = await runCli(['triggers', '--help']);
    for (const fragment of ['monitors, and app events', '--connector <slug>', '--account <label>', '--default-account', '--event <TYPE>', '--config <key=value>', '--config-json <json>', 'events --connector <slug>', 'event.data.<field>']) {
      expect(result.stdout).toContain(fragment);
    }
  });

  test('add writes an event block with connector, event, and config', async () => {
    const result = await add(
      '--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT',
      '--config', 'owner=acme', '--config-json', '{"repo":"app","draft":false}',
    );
    expect(result.code).toBe(0);
    const text = manifestText();
    expect(text).toContain('type: event');
    expect(text).toContain('connector: github');
    expect(text).toContain('event: GITHUB_PULL_REQUEST_EVENT');
    expect(text).toContain('owner: acme');
    expect(text).toContain('repo: app');
    expect(text).toContain('draft: false');
    expect(text).not.toContain('cron');
    expect(text).not.toContain('timezone');
  });

  test('add --account writes account under connector; omitted writes none', async () => {
    const result = await add('--connector', 'github', '--account', 'acme-bot', '--event', 'GITHUB_PULL_REQUEST_EVENT');
    expect(result.code).toBe(0);
    expect(manifestText()).toContain('account: acme-bot');
    const stray = await runCli(['triggers', 'add', 'c', '--cron', '0 0 9 * * *', '--account', 'x', '--prompt', 'x']);
    expect(stray.stderr).toContain('--account is only valid on an event trigger');
  });

  test('add without --config omits the config key', async () => {
    const result = await add('--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT');
    expect(result.code).toBe(0);
    expect(manifestText()).not.toContain('config');
  });

  test('add rejects a missing --connector or --event', async () => {
    const noConnector = await add('--event', 'X');
    expect(noConnector.code).toBe(2);
    expect(noConnector.stderr).toContain('--connector');
    const noEvent = await add('--connector', 'github');
    expect(noEvent.code).toBe(2);
    expect(noEvent.stderr).toContain('--event');
    expect(manifestText()).not.toContain('new-pr');
  });

  test('add rejects schedule, webhook, and monitor flags on an event', async () => {
    for (const flag of [['--cron', '0 0 9 * * *'], ['--timezone', 'UTC'], ['--secret-env', 'S'], ['--run', './m.ts'], ['--interval', '60s']]) {
      const result = await add('--connector', 'github', '--event', 'X', ...flag);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`${flag[0]} is not valid on an event trigger`);
    }
  });

  test('add rejects event flags on other types', async () => {
    const result = await runCli(['triggers', 'add', 'c', '--cron', '0 0 9 * * *', '--connector', 'github', '--prompt', 'x']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--connector is only valid on an event trigger');
  });

  test('add rejects malformed --config and --config-json', async () => {
    const pair = await add('--connector', 'github', '--event', 'X', '--config', 'nokey');
    expect(pair.code).toBe(2);
    expect(pair.stderr).toContain('key=value');
    const json = await add('--connector', 'github', '--event', 'X', '--config-json', '[1]');
    expect(json.code).toBe(2);
    expect(json.stderr).toContain('JSON object');
  });

  test('unknown --type names all four types', async () => {
    const result = await runCli(['triggers', 'add', 'x', '--type', 'bogus', '--prompt', 'x']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('cron, webhook, monitor, or event');
  });

  test('events prints the table and config fields; --json prints the raw response', async () => {
    const cfg = writeConfig(startServer([]));
    const result = await runCli(['triggers', 'events', '--connector', 'github', '--project', PROJECT], cfg);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('GITHUB_PULL_REQUEST_EVENT');
    expect(result.stdout).toContain('Pull request');
    expect(result.stdout).toContain('poll');
    expect(result.stdout).toContain('--event <TYPE>');
    const raw = await runCli(['triggers', 'events', '--connector', 'github', '--json', '--project', PROJECT], cfg);
    expect(JSON.parse(raw.stdout)).toEqual(EVENT_TYPES);
    const noConnector = await runCli(['triggers', 'events', '--project', PROJECT], cfg);
    expect(noConnector.code).toBe(2);
  });

  test('events --event prints config fields and prompt variables', async () => {
    const cfg = writeConfig(startServer([]));
    const r = await runCli(['triggers', 'events', '--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('owner (string, required) — Repository owner');
    expect(r.stdout).toContain('repo (string, optional, e.g. "app")');
    expect(r.stdout).toContain('limit (integer, optional, default 30)');
    expect(r.stdout).toContain('{{ event.data.title }} — PR title');
    expect(r.stdout).toContain('delivery poll');
    const missing = await runCli(['triggers', 'events', '--connector', 'github', '--event', 'NOPE', '--project', PROJECT], cfg);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('Unknown event NOPE');
  });

  test('events --apps lists apps with connector and state', async () => {
    const cfg = writeConfig(startServer([]));
    const r = await runCli(['triggers', 'events', '--apps', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/github\s+12 events\s+connected/);
    expect(r.stdout).toMatch(/acme-bot\s+as acme-bot-user\s+default/);
    expect(r.stdout).toMatch(/acme-ci\s+/);
    expect(r.stdout).toMatch(/github-work\s+no shared account/);
        expect(r.stdout).toMatch(/No connector yet \(2\): gmail \(3\), linear \(5\)/);
    const raw = await runCli(['triggers', 'events', '--apps', '--json', '--project', PROJECT], cfg);
    expect(JSON.parse(raw.stdout)).toEqual(EVENT_APPS);
  });

  test('local add coerces and validates against the catalog when online', async () => {
    config = writeConfig(startServer([]));
    const ok = await add('--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT', '--config', 'owner=acme', '--config', 'limit=5', '--project', PROJECT);
    expect(ok.code).toBe(0);
    expect(manifestText()).toContain('limit: 5');
    const bad = await runCli(['triggers', 'add', 'other', '--type', 'event', '--prompt', 'p', '--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT', '--project', PROJECT]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('owner is required — Repository owner');
    expect(manifestText()).not.toContain('slug: other');
  });

  test('local add offline writes as given and says it was not checked', async () => {
    const r = await runCli(['triggers', 'add', 'x', '--type', 'event', '--prompt', 'p', '--connector', 'github', '--event', 'E'], join(tmp, 'absent.json'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('not checked against the event catalog');
  });

  test('ls and info render the connector, event, status, and error', async () => {
    const cfg = writeConfig(startServer([EVENT_TRIGGER]));
    const ls = await runCli(['triggers', 'ls', '--project', PROJECT], cfg);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('GITHUB_PULL_REQUEST_EVENT');
    expect(ls.stdout).toContain('needs connection');
    const info = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
    expect(info.code).toBe(0);
    expect(info.stdout).toContain('connector');
    expect(info.stdout).toContain('github (github)');
    expect(info.stdout).toMatch(/account\s+default/);
    expect(info.stdout).toMatch(/connected as\s+—/);
    expect(info.stdout).toContain('GITHUB_PULL_REQUEST_EVENT');
    expect(info.stdout).toContain('{"owner":"acme","repo":"app"}');
    expect(info.stdout).toContain('needs connection');
    expect(info.stdout).toContain('No connected account');
    expect(info.stdout).toContain('last_event');
    expect(info.stdout).toContain('kortix connectors connect github --owner project');
  });

  test('ls shows connector/account and info shows connected as', async () => {
    const t = { ...EVENT_TRIGGER, event: { ...EVENT_TRIGGER.event, account: 'acme-bot', connected_as: 'acme-bot-user', status: 'active', error: null } };
    const cfg = writeConfig(startServer([t]));
    const ls = await runCli(['triggers', 'ls', '--project', PROJECT], cfg);
    expect(ls.stdout).toContain('github/acme-bot GITHUB_PULL_REQUEST_EVENT');
    const info = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
    expect(info.stdout).toMatch(/account\s+acme-bot/);
    expect(info.stdout).toMatch(/connected as\s+acme-bot-user/);
  });

  test('needs_connection with an account names the label', async () => {
    const t = { ...EVENT_TRIGGER, event: { ...EVENT_TRIGGER.event, account: 'acme-bot' } };
    const cfg = writeConfig(startServer([t]));
    const info = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
    expect(info.stdout).toContain('labelled "acme-bot" on github');
  });
});
