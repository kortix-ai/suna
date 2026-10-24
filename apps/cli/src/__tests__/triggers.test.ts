import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProjectTrigger } from '../api/types.ts';
import { eventNextStep } from '../commands/triggers-events.ts';
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
const PROJECT = 'triggers_project';

let tmp: string;
let config: string;
let server: ReturnType<typeof Bun.serve> | null = null;

const APP_TRIGGER = {
  slug: 'checkout-errors',
  path: 'kortix.yaml#triggers.checkout-errors',
  name: 'Checkout errors',
  type: 'app',
  app: 'checkout-watcher',
  agent: 'oncall',
  model: null,
  enabled: true,
  cron: null,
  run_at: null,
  timezone: 'UTC',
  secret_env: null,
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  prompt_template: 'Checkout watcher emitted: {{ event.name }}',
  session_mode: 'reuse',
  session_id: null,
  session_key: null,
  filter: null,
  last_fired_at: null,
  webhook_url: null,
  event: null,
};

const WEBHOOK_TRIGGER = {
  ...APP_TRIGGER,
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
  ...APP_TRIGGER,
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

const eventTypesQueries: string[] = [];

function startServer(triggers: unknown[]): string {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname, search } = new URL(req.url);
      if (pathname.endsWith('/triggers/event-types')) eventTypesQueries.push(search);
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

describe('kortix triggers — monitors (removed)', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    config = writeConfig('http://127.0.0.1:1');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('add --type monitor answers the removal message naming the App replacement and writes nothing', async () => {
    const result = await runCli(['triggers', 'add', 'checkout-errors', '--type', 'monitor', '--prompt', 'x']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('monitor triggers were removed');
    expect(result.stderr).toContain('--type app');
    expect(manifestText()).not.toContain('checkout-errors');
  });
});

describe('kortix triggers fire — reports the run outcome', () => {
  const SESSION_ID = 'b3f0c2a1-0000-4000-8000-000000000001';
  const FAILURE_TEXT = 'Payment Required: Insufficient credits. Balance: $-0.06';
  const FIRE_RUN_ID = 'b3f0c2a1-0000-4000-8000-0000000000aa';

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
              run_id: FIRE_RUN_ID,
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
    // Fails after the CLI reads its anchor, even on a loaded runner: a failure
    // before that read is a known gap (it reads as the previous run's).
    state.failAfterMs = 1500;
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
    expect(result.stdout).toContain(`Fired dogfood-cron → run ${FIRE_RUN_ID} → session ${SESSION_ID}`);
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
    // Fails after the CLI reads its anchor, even on a loaded runner: a failure
    // before that read is a known gap (it reads as the previous run's).
    state.failAfterMs = 1500;
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

  test('info on a Kortix-polled trigger prints when the app was checked and is checked next', async () => {
    const polled = {
      ...EVENT_TRIGGER,
      slug: 'inbox-watch',
      event: {
        ...EVENT_TRIGGER.event,
        connector: 'inbox', type: 'new_item.list_items', config: { interval: 5 }, source: 'mcp', provider: 'mcp', app: 'inbox',
        status: 'active', error: null, checked_at: '2026-10-19T04:00:00.000Z', next_check_at: '2026-10-19T04:05:00.000Z',
      },
    };
    const cfg = writeConfig(startServer([polled, EVENT_TRIGGER]));
    const result = await runCli(['triggers', 'info', 'inbox-watch', '--project', PROJECT], cfg);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/checked\s+2026-10-19T04:00:00.000Z/);
    expect(result.stdout).toMatch(/next_check\s+2026-10-19T04:05:00.000Z/);
    // A Composio trigger is checked by nobody: no such rows.
    const composio = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
    expect(composio.stdout).not.toContain('next_check');
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
    for (const fragment of ['connector events, and App events', '--connector <slug>', '--account <label>', '--source <adapter>', '--default-account', '--event <TYPE>', '--config <key=value>', '--config-json <json>', 'events --connector <slug>', 'event.data.<field>']) {
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
    // Written in the on/run shape: on carries the event, run the prompt.
    expect(text).toContain('on:');
    expect(text).not.toContain('type:');
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

  test('add --source writes source under connector; omitted writes none; non-event rejects it', async () => {
    const result = await add('--connector', 'github', '--source', 'composio', '--event', 'GITHUB_PULL_REQUEST_EVENT');
    expect(result.code).toBe(0);
    expect(manifestText()).toContain('source: composio');
    const stray = await runCli(['triggers', 'add', 'c', '--cron', '0 0 9 * * *', '--source', 'composio', '--prompt', 'x']);
    expect(stray.stderr).toContain('--source is only valid on an event trigger');
  });

  test('add without --source writes no source', async () => {
    const result = await add('--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT');
    expect(result.code).toBe(0);
    expect(manifestText()).not.toContain('source:');
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

  test('add rejects schedule and webhook flags on an event', async () => {
    for (const flag of [['--cron', '0 0 9 * * *'], ['--timezone', 'UTC'], ['--secret-env', 'S']]) {
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
    expect(result.stderr).toContain('cron, webhook, event, or app');
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

  test('events --app lists an app\'s events with no connector; --event shows one; --json is raw', async () => {
    const cfg = writeConfig(startServer([]));
    eventTypesQueries.length = 0;
    const r = await runCli(['triggers', 'events', '--app', 'github', '--source', 'composio', '--project', PROJECT], cfg);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('GITHUB_PULL_REQUEST_EVENT');
    expect(r.stdout).toContain('kortix triggers events --app github --event <TYPE>');
    const one = await runCli(['triggers', 'events', '--app', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT', '--project', PROJECT], cfg);
    expect(one.code).toBe(0);
    expect(one.stdout).toContain('owner (string, required) — Repository owner');
    expect(one.stdout).toContain('kortix connectors add <slug> --provider composio --app github');
    const raw = await runCli(['triggers', 'events', '--app', 'github', '--json', '--project', PROJECT], cfg);
    expect(JSON.parse(raw.stdout)).toEqual(EVENT_TYPES);
    // Without --source, the source comes from the app listing, where github is a composio app.
    expect(eventTypesQueries).toEqual(['?app=github&source=composio', '?app=github&source=composio', '?app=github&source=composio']);
    const both = await runCli(['triggers', 'events', '--app', 'github', '--connector', 'github', '--project', PROJECT], cfg);
    expect(both.code).toBe(2);
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
    expect(r.stdout).toContain('source: composio');
    expect(r.stdout).toMatch(/github\s+12 events\s+connected/);
    expect(r.stdout).toMatch(/acme-bot\s+as acme-bot-user\s+default/);
    expect(r.stdout).toMatch(/acme-ci\s+/);
    expect(r.stdout).toMatch(/github-work\s+no shared account/);
    expect(r.stdout).toMatch(/No connector yet, source composio \(2\): gmail \(3\), linear \(5\)/);
    expect(r.stdout).toContain('Add a connector: kortix connectors add <slug> --provider composio --app <app> --apply');
    expect(r.stdout).not.toContain('--provider mcp');
    expect(r.stdout).toContain('kortix triggers ls --type event');
    expect(r.stdout).toContain('kortix triggers ls --connector <slug>');
    const raw = await runCli(['triggers', 'events', '--apps', '--json', '--project', PROJECT], cfg);
    expect(JSON.parse(raw.stdout)).toEqual(EVENT_APPS);
  });

  test('flag off: events and live add print the one flag line and exit 1; cron add is untouched', async () => {
    const gate = { error: 'App event triggers is not enabled for this project.', code: 'feature_disabled', feature: 'event_triggers' };
    server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const { pathname } = new URL(req.url);
        if (req.method === 'POST' && pathname.endsWith('/triggers')) {
          return req.json().then((body: { type?: string }) =>
            body.type === 'event'
              ? Response.json(gate, { status: 403 })
              : Response.json({ triggers: [], errors: [], triggers_paused: false }, { status: 201 }),
          );
        }
        if (pathname.endsWith('/triggers/event-apps') || pathname.endsWith('/triggers/event-types')) {
          return Response.json(gate, { status: 403 });
        }
        return Response.json({ triggers: [], errors: [], triggers_paused: false });
      },
    });
    const cfg = writeConfig(`http://127.0.0.1:${server.port}`);
    const line = 'Connector event triggers are off for this project. Turn them on: kortix projects features enable event_triggers';
    for (const args of [
      ['triggers', 'events', '--apps'],
      ['triggers', 'events', '--connector', 'github'],
      ['triggers', 'events', '--app', 'github'],
      ['triggers', 'add', 'new-pr', '--type', 'event', '--connector', 'github', '--event', 'X', '--prompt', 'p', '--apply'],
    ]) {
      const r = await runCli([...args, '--project', PROJECT], cfg);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(line);
      // The host banner is the other stderr line; the failure is exactly one line.
      expect(r.stderr.split('\n').filter((l) => l.includes('✗'))).toHaveLength(1);
    }
    const cron = await runCli(['triggers', 'add', 'daily', '--cron', '0 0 9 * * *', '--prompt', 'p', '--apply', '--project', PROJECT], cfg);
    expect(cron.code).toBe(0);
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

  test('info shows the source; ls adds it only when it is not the connector provider', async () => {
    const same = { ...EVENT_TRIGGER, event: { ...EVENT_TRIGGER.event, source: 'composio' } };
    const cfg = writeConfig(startServer([same]));
    const info = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
    expect(info.stdout).toMatch(/source\s+composio/);
    const ls = await runCli(['triggers', 'ls', '--project', PROJECT], cfg);
    expect(ls.stdout).toContain('github/default GITHUB_PULL_REQUEST_EVENT');
    expect(ls.stdout).not.toContain('composio:github');
    const differs = { ...EVENT_TRIGGER, event: { ...EVENT_TRIGGER.event, source: 'composio', provider: 'pipedream' } };
    const ls2 = await runCli(['triggers', 'ls', '--project', PROJECT], writeConfig(startServer([differs])));
    expect(ls2.stdout).toContain('composio:github/');
  });

  test('needs_connection with an account names the label', async () => {
    const t = { ...EVENT_TRIGGER, event: { ...EVENT_TRIGGER.event, account: 'acme-bot' } };
    const cfg = writeConfig(startServer([t]));
    const info = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
    expect(info.stdout).toContain('labelled "acme-bot" on github');
  });

  describe('source mcp (Kortix-polled app events)', () => {
    const LINEAR_URL = 'https://mcp.linear.example.test/mcp';
    const NOTES_URL = 'https://mcp.notes.example.test/mcp';
    const INTERVAL = {
      type: 'integer',
      title: 'Check every (minutes)',
      description: 'How often Kortix checks the app. A new item fires within this many minutes.',
      enum: [1, 5, 15, 30, 60, 360, 1440],
      default: 5,
    };
    const NEW_EMAIL = {
      type: 'gmail.message.received',
      name: 'New email',
      description: 'An email arrives that matches your search.',
      app: 'gmail',
      delivery: 'poll',
      config_schema: { type: 'object', properties: { query: { type: 'string', description: 'A Gmail search.' }, interval: INTERVAL } },
      payload_schema: { type: 'object', properties: { subject: { type: 'string', description: 'Subject line' } } },
    };
    const NEW_ITEM = {
      ...NEW_EMAIL,
      type: 'new_item.search',
      name: 'New item from search',
      app: 'docs-search',
      config_schema: { type: 'object', properties: { interval: INTERVAL } },
      payload_schema: null,
    };
    const mcpApp = (over: Record<string, unknown>) => ({
      source: 'mcp', provider: 'mcp', logo: null, connector: null, connected: false, connectors: [], mcp_url: null, ...over,
    });
    // A connectors_v2 project: Composio only where it has a connector; every MCP catalogue app.
    const MCP_APPS = {
      apps: [
        { ...EVENT_APPS.apps[0], source: 'composio', mcp_url: null },
        mcpApp({
          app: 'gmail', name: 'Gmail', event_count: 1, connector: 'gmail', new_connector_slug: 'gmail-events', mcp_url: 'https://mcp.gmail.example.test/mcp',
          connectors: [{ slug: 'gmail', name: 'Gmail', accounts: [{ label: 'support', connected_as: null, is_default: true, connected: false }] }],
        }),
        mcpApp({
          app: 'docs-search', name: 'Docs search', event_count: 1, connector: 'docs-search', connected: true, new_connector_slug: 'docs-search-events',
          connectors: [{ slug: 'docs-search', name: 'Docs search', accounts: [{ label: 'Docs search', connected_as: null, is_default: true, connected: true }] }],
        }),
        mcpApp({ app: 'linear', name: 'Linear', event_count: 0, new_connector_slug: 'linear', mcp_url: LINEAR_URL }),
        mcpApp({ app: 'notes', name: 'Notes', event_count: 1, new_connector_slug: 'notes-events', mcp_url: NOTES_URL }),
      ],
    };
    let requests: string[];

    function startMcpServer(): string {
      requests = [];
      server = Bun.serve({
        port: 0,
        fetch: (req) => {
          const { pathname, search } = new URL(req.url);
          if (pathname.includes('/triggers/')) requests.push(`${pathname.replace(/^.*\/triggers\//, '/triggers/')}${search}`);
          if (pathname.endsWith('/triggers/event-apps')) return Response.json(MCP_APPS);
          if (pathname.endsWith('/triggers/event-types')) {
            const q = new URLSearchParams(search);
            const app = q.get('app') ?? q.get('connector') ?? '';
            const types = app === 'gmail' || app === 'notes' ? [{ ...NEW_EMAIL, app }] : app === 'docs-search' ? [NEW_ITEM] : [];
            return Response.json({ source: 'mcp', provider: 'mcp', app, event_types: types });
          }
          return Response.json({ triggers: [], errors: [], triggers_paused: false });
        },
      });
      return `http://127.0.0.1:${server.port}`;
    }

    test('--apps tells mcp and composio apps apart and prints the MCP add path', async () => {
      const cfg = writeConfig(startMcpServer());
      const r = await runCli(['triggers', 'events', '--apps', '--project', PROJECT], cfg);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/source: composio\n\s+github\s+12 events\s+connected/);
      expect(r.stdout).toMatch(/source: mcp\n\s+gmail\s+1 event\s+needs account/);
      expect(r.stdout).toMatch(/docs-search\s+1 event\s+connected/);
      expect(r.stdout).toContain('No connector yet, source mcp (2): linear (0), notes (1, add as notes-events)');
      expect(r.stdout).toContain(
        'Add an MCP app (its read-only list tools become events too): kortix connectors add <slug> --provider mcp --url <mcp_url> --apply, then sign it in for the project: kortix connectors authorize <slug>.',
      );
      // connectors_v2 adds apps from the MCP catalogue: no Composio add line.
      expect(r.stdout).not.toContain('--provider composio');
      const raw = await runCli(['triggers', 'events', '--apps', '--json', '--project', PROJECT], cfg);
      expect(JSON.parse(raw.stdout).apps.map((a: { mcp_url: string | null }) => a.mcp_url)).toEqual([
        null, 'https://mcp.gmail.example.test/mcp', null, LINEAR_URL, NOTES_URL,
      ]);
    });

    test('--app on a catalogue app with no connector prints its add, sign-in, and trigger commands', async () => {
      const cfg = writeConfig(startMcpServer());
      const one = await runCli(['triggers', 'events', '--app', 'notes', '--event', 'gmail.message.received', '--project', PROJECT], cfg);
      expect(one.code).toBe(0);
      expect(one.stdout).toContain(`1. kortix connectors add notes-events --provider mcp --url ${NOTES_URL} --apply`);
      expect(one.stdout).toContain('2. kortix connectors authorize notes-events  (a person signs in; the account is shared with the project)');
      expect(one.stdout).toContain('3. kortix triggers add <slug> --type event --connector notes-events --event gmail.message.received --prompt "…" --apply');
      expect(one.stdout).not.toContain('--provider composio');
      const list = await runCli(['triggers', 'events', '--app', 'notes', '--project', PROJECT], cfg);
      expect(list.stdout).toContain('1 event type on notes (mcp). Details: kortix triggers events --app notes --event <TYPE>');
      expect(list.stdout).toContain('Set it up first:');
      expect(list.stdout).toContain(`kortix connectors add notes-events --provider mcp --url ${NOTES_URL} --apply`);
      const empty = await runCli(['triggers', 'events', '--app', 'linear', '--project', PROJECT], cfg);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain('linear has no event types yet. Its read-only list tools become events after these steps:');
      expect(empty.stdout).toContain(`1. kortix connectors add linear --provider mcp --url ${LINEAR_URL} --apply`);
      expect(empty.stdout).toContain('2. kortix connectors authorize linear');
      // No --source: the app is listed under mcp only, so the CLI asks for mcp (the API defaults to composio).
      expect(requests).toContain('/triggers/event-types?app=linear&source=mcp');
      await runCli(['triggers', 'events', '--app', 'linear', '--source', 'composio', '--project', PROJECT], cfg);
      expect(requests).toContain('/triggers/event-types?app=linear&source=composio');
    });

    test('--app on an app with a connector: sign in when needed, never add it again', async () => {
      const cfg = writeConfig(startMcpServer());
      const gmail = await runCli(['triggers', 'events', '--app', 'gmail', '--event', 'gmail.message.received', '--project', PROJECT], cfg);
      expect(gmail.code).toBe(0);
      expect(gmail.stdout).toContain('1. kortix connectors authorize gmail');
      expect(gmail.stdout).toContain('2. kortix triggers add <slug> --type event --connector gmail --event gmail.message.received');
      expect(gmail.stdout).not.toContain('connectors add');
      // A project MCP server (no mcp_url) is its own connector, already signed in: only the trigger line.
      const custom = await runCli(['triggers', 'events', '--app', 'docs-search', '--event', 'new_item.search', '--project', PROJECT], cfg);
      expect(custom.code).toBe(0);
      expect(custom.stdout).toContain('Add it: kortix triggers add <slug> --type event --connector docs-search --event new_item.search --prompt "…" --apply');
      expect(custom.stdout).not.toContain('connectors add');
      expect(custom.stdout).not.toContain('authorize');
    });

    test('--connector needs no app listing; --json stays the raw catalog', async () => {
      const cfg = writeConfig(startMcpServer());
      const r = await runCli(['triggers', 'events', '--connector', 'gmail', '--event', 'gmail.message.received', '--project', PROJECT], cfg);
      expect(r.stdout).toContain('Add it: kortix triggers add <slug> --type event --connector gmail --event gmail.message.received');
      const raw = await runCli(['triggers', 'events', '--app', 'gmail', '--json', '--project', PROJECT], cfg);
      expect(JSON.parse(raw.stdout).event_types[0].type).toBe('gmail.message.received');
      expect(requests).toEqual(['/triggers/event-types?connector=gmail', '/triggers/event-apps', '/triggers/event-types?app=gmail&source=mcp']);
    });

    test('--event prints the interval enum readably; add coerces and checks it', async () => {
      config = writeConfig(startMcpServer());
      const r = await runCli(['triggers', 'events', '--connector', 'gmail', '--event', 'gmail.message.received', '--project', PROJECT]);
      expect(r.stdout).toContain(
        'interval (integer, optional, default 5, one of 1, 5, 15, 30, 60, 360, 1440) — How often Kortix checks the app. A new item fires within this many minutes.',
      );
      expect(r.stdout).toContain('query (string, optional) — A Gmail search.');
      expect(r.stdout).toContain('delivery poll');
      const ok = await add('--connector', 'gmail', '--event', 'gmail.message.received', '--config', 'interval=15', '--project', PROJECT);
      expect(ok.code).toBe(0);
      expect(manifestText()).toContain('interval: 15');
      const bad = await runCli(['triggers', 'add', 'odd', '--type', 'event', '--prompt', 'p', '--connector', 'gmail', '--event', 'gmail.message.received', '--config', 'interval=7', '--project', PROJECT]);
      expect(bad.code).not.toBe(0);
      expect(bad.stderr).toContain('interval must be one of 1, 5, 15, 30, 60, 360, 1440 (got "7")');
      expect(manifestText()).not.toContain('slug: odd');
    });

    test('needs_connection on an mcp connector points at authorize, not a connect link', async () => {
      const t = { ...EVENT_TRIGGER, event: { ...EVENT_TRIGGER.event, connector: 'gmail', app: 'gmail', type: 'gmail.message.received', source: 'mcp', provider: 'mcp', config: {} } };
      const cfg = writeConfig(startServer([t]));
      const info = await runCli(['triggers', 'info', 'new-pr', '--project', PROJECT], cfg);
      expect(info.code).toBe(0);
      expect(info.stdout).toContain('A person must sign it in: kortix connectors authorize gmail');
      expect(info.stdout).not.toContain('connectors connect');
      const labelled = eventNextStep({ ...t, event: { ...t.event, account: 'support' } } as unknown as ProjectTrigger);
      expect(labelled.lines[0]).toContain('kortix connectors authorize gmail');
      expect(labelled.lines[0]).toContain('kortix connectors connections default <id>');
    });
  });

  describe('ls filters', () => {
    const second = {
      ...EVENT_TRIGGER,
      slug: 'new-issue',
      name: 'New issue',
      event: { ...EVENT_TRIGGER.event, connector: 'github-work', type: 'GITHUB_ISSUE_EVENT' },
    };
    const mail = {
      ...EVENT_TRIGGER,
      slug: 'new-mail',
      name: 'New mail',
      event: { ...EVENT_TRIGGER.event, connector: 'gmail', app: 'gmail', type: 'GMAIL_NEW_MESSAGE' },
    };
    const all = [APP_TRIGGER, EVENT_TRIGGER, second, mail];
    const slugs = (json: string) =>
      (JSON.parse(json).triggers as { slug: string }[]).map((t) => t.slug);

    test('--type event keeps only app events and groups them by app', async () => {
      const cfg = writeConfig(startServer(all));
      const r = await runCli(['triggers', 'ls', '--type', 'event', '--project', PROJECT], cfg);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/github \(2\)\n[\s\S]*new-pr[\s\S]*new-issue/);
      expect(r.stdout).toMatch(/gmail \(1\)\n[\s\S]*new-mail/);
      expect(r.stdout).not.toContain('checkout-errors');
      expect(r.stdout).toContain('3 triggers');
    });

    test('--connector keeps the app events of one connector; --json respects it', async () => {
      const cfg = writeConfig(startServer(all));
      const r = await runCli(
        ['triggers', 'ls', '--connector', 'github-work', '--json', '--project', PROJECT],
        cfg,
      );
      expect(r.code).toBe(0);
      expect(slugs(r.stdout)).toEqual(['new-issue']);
    });

    test('--type and --connector combine; a mismatch lists nothing', async () => {
      const cfg = writeConfig(startServer(all));
      const both = await runCli(
        ['triggers', 'ls', '--type', 'event', '--connector', 'gmail', '--json', '--project', PROJECT],
        cfg,
      );
      expect(slugs(both.stdout)).toEqual(['new-mail']);
      const none = await runCli(
        ['triggers', 'ls', '--type', 'app', '--connector', 'gmail', '--project', PROJECT],
        cfg,
      );
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('No trigger matches that filter');
    });

    test('--type app keeps the app trigger; an unknown type exits 2', async () => {
      const cfg = writeConfig(startServer(all));
      const ok = await runCli(
        ['triggers', 'ls', '--type', 'app', '--json', '--project', PROJECT],
        cfg,
      );
      expect(slugs(ok.stdout)).toEqual(['checkout-errors']);
      const bad = await runCli(['triggers', 'ls', '--type', 'nope', '--project', PROJECT], cfg);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain('Unknown --type "nope"');
    });
  });
});

describe('eventNextStep on an error', () => {
  const errored = (event: Record<string, unknown>) =>
    ({
      slug: 'pr-review',
      event: { connector: 'docs', type: 'GITHUB_PULL_REQUEST_CREATED', status: 'error', ...event },
    }) as unknown as ProjectTrigger;

  test('a source the connector cannot serve points at the connector, not the config', () => {
    const { lines } = eventNextStep(
      errored({ source: 'composio', provider: 'mcp', error: 'Connector "docs" is a mcp connector; source "composio" needs a composio connector.' }),
    );
    expect(lines.join('\n')).toContain('kortix triggers set pr-review --connector <a composio connector>');
    expect(lines.join('\n')).not.toContain('--config');
  });

  test('an undeclared connector points at the connector, not the config', () => {
    const { lines } = eventNextStep(errored({ source: null, provider: null, error: 'Connector "docs" is not declared in kortix.yaml.' }));
    expect(lines.join('\n')).toContain('kortix triggers set pr-review --connector <slug>');
    expect(lines.join('\n')).not.toContain('--config');
  });

  test('the flag-off error points at the flag, not the config', () => {
    const { lines } = eventNextStep(
      errored({ source: 'composio', provider: 'composio', error: 'App event triggers are off for this project. Turn them on in Settings → Feature flags.' }),
    );
    expect(lines.join('\n')).toContain('kortix projects features enable event_triggers');
    expect(lines.join('\n')).not.toContain('--config');
  });

  test('a provider rejection still points at the config', () => {
    const { lines } = eventNextStep(errored({ source: 'composio', provider: 'composio', error: 'repo is required' }));
    expect(lines.join('\n')).toContain('kortix triggers set pr-review --config <key>=<value>');
  });
});

/**
 * Run history (KRTX-1743): `runs`, `fire --payload/--dry-run`, `replay`, as a
 * real process against a served API. Each case asserts the exit code, the
 * output, and the HTTP request the CLI sent.
 */
describe('kortix triggers — runs, payload fires, dry runs, replay', () => {
  const base = `/v1/projects/${PROJECT}/triggers`;
  const RUN_ID = '11111111-0000-4000-8000-000000000001';
  const NEW_RUN_ID = '11111111-0000-4000-8000-000000000002';
  const SESSION_ID = '22222222-0000-4000-8000-000000000001';
  let requests: Array<{ method: string; path: string; search: string; body: unknown }>;
  let replayAnswer: { status: number; body: unknown };
  let emptyPage: boolean;

  const run = (over: Record<string, unknown> = {}) => ({
    run_id: RUN_ID,
    slug: 'tickets',
    source: 'webhook',
    status: 'fired',
    run_status: 'succeeded',
    error: null,
    run_error: null,
    session_id: SESSION_ID,
    command_id: null,
    replay_of: null,
    payload_verified: true,
    payload: { body: { ticket: 'T-9' } },
    scheduled_for: null,
    created_at: '2026-10-16T18:03:54.382Z',
    started_at: '2026-10-16T18:03:54.382Z',
    ended_at: '2026-10-16T18:08:54.382Z',
    duration_ms: 300_000,
    cost_usd: 0.25,
    ...over,
  });

  function startRunsServer(): string {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const text = await req.text();
        requests.push({
          method: req.method,
          path: url.pathname,
          search: url.search,
          body: text ? JSON.parse(text) : null,
        });
        if (url.pathname === `${base}/tickets/runs` && req.method === 'GET') {
          if (emptyPage) return Response.json({ runs: [], next_cursor: 'c-older' });
          return Response.json({
            runs: [run(), run({ run_id: NEW_RUN_ID, status: 'failed', run_status: null, error: 'Insufficient credits', session_id: null, duration_ms: null, cost_usd: null, replay_of: RUN_ID })],
            next_cursor: 'c-next',
          });
        }
        if (url.pathname === `${base}/tickets/fire` && req.method === 'POST') {
          const body = text ? JSON.parse(text) : {};
          if (body.dry_run) {
            return Response.json({ dry_run: true, rendered_prompt: 'Ticket T-1 from manual', filter_matches: false, session_key: 'T-1', payload: body.payload ?? {} });
          }
          return Response.json({ status: 'queued', reason: 'busy', session_id: null, command_id: null, deduped: false, run_id: NEW_RUN_ID }, { status: 202 });
        }
        if (url.pathname === `${base}/tickets/runs/${RUN_ID}/replay` && req.method === 'POST') {
          return Response.json(replayAnswer.body, { status: replayAnswer.status });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  const sent = (method: string, suffix: string) =>
    requests.filter((r) => r.method === method && r.path === `${base}${suffix}`);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-runs-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    requests = [];
    emptyPage = false;
    replayAnswer = { status: 202, body: { status: 'fired', session_id: SESSION_ID, command_id: null, deduped: false, run_id: NEW_RUN_ID } };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('runs prints the table, newest first, and the next-page hint; --limit and --status reach the query', async () => {
    const result = await runCli(
      ['triggers', 'runs', 'tickets', '--limit', '2', '--status', 'fired', '--project', PROJECT],
      writeConfig(startRunsServer()),
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n');
    const header = lines.find((l) => l.includes('STARTED'))!;
    expect(header.trim().startsWith('RUN ')).toBe(true);
    for (const col of ['SOURCE', 'STATUS', 'RUN STATUS', 'DURATION', 'COST', 'SESSION']) expect(header).toContain(col);
    const first = lines.findIndex((l) => l.includes(SESSION_ID));
    const second = lines.findIndex((l) => l.includes('webhook (replay)'));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(lines[first]).toContain('5m 0s');
    expect(lines[first]!.trim().startsWith(RUN_ID)).toBe(true);
    expect(lines[second]!.trim().startsWith(NEW_RUN_ID)).toBe(true);
    expect(lines[first]).toContain('$0.25');
    // Local time of the CLI process (bun test pins its own TZ to UTC, the child keeps the machine's).
    expect(lines[first]).toMatch(/2026/);
    expect(result.stdout).toContain('Insufficient credits');
    expect(result.stdout).toContain('--cursor c-next');
    const [get] = sent('GET', '/tickets/runs');
    expect(new URLSearchParams(get!.search).get('limit')).toBe('2');
    expect(new URLSearchParams(get!.search).get('status')).toBe('fired');
  });

  test('runs --json prints the raw list; --cursor is passed through', async () => {
    const result = await runCli(
      ['triggers', 'runs', 'tickets', '--cursor', 'c-next', '--json', '--project', PROJECT],
      writeConfig(startRunsServer()),
    );
    expect(result.code).toBe(0);
    const list = JSON.parse(result.stdout);
    expect(list.runs.map((r: { run_id: string }) => r.run_id)).toEqual([RUN_ID, NEW_RUN_ID]);
    expect(list.next_cursor).toBe('c-next');
    expect(new URLSearchParams(sent('GET', '/tickets/runs')[0]!.search).get('cursor')).toBe('c-next');
  });

  test('runs rejects an unknown --status and a bad --limit before any HTTP call', async () => {
    const apiConfig = writeConfig(startRunsServer());
    const bad = await runCli(['triggers', 'runs', 'tickets', '--status', 'succeeded', '--project', PROJECT], apiConfig);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--status');
    const limit = await runCli(['triggers', 'runs', 'tickets', '--limit', '101', '--project', PROJECT], apiConfig);
    expect(limit.code).toBe(2);
    expect(limit.stderr).toContain('--limit must be an integer from 1 to 100');
    expect(sent('GET', '/tickets/runs')).toEqual([]);
  });

  test('runs: an empty page with a next_cursor still prints the --cursor hint', async () => {
    emptyPage = true;
    const result = await runCli(['triggers', 'runs', 'tickets', '--project', PROJECT], writeConfig(startRunsServer()));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('No runs of tickets on this page');
    expect(result.stdout).toContain('--cursor c-older');
  });

  test('fire --dry-run sends {dry_run, payload} and prints the prompt, the filter verdict and the session key', async () => {
    const result = await runCli(
      ['triggers', 'fire', 'tickets', '--payload', '{"body":{"ticket":"T-1","kind":"bug"}}', '--dry-run', '--project', PROJECT],
      writeConfig(startRunsServer()),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Ticket T-1 from manual');
    expect(result.stdout).toContain('does not match');
    expect(result.stdout).toContain('T-1');
    expect(sent('POST', '/tickets/fire').map((r) => r.body)).toEqual([
      { dry_run: true, payload: { body: { ticket: 'T-1', kind: 'bug' } } },
    ]);
  });

  test('fire --dry-run --json prints the raw response; @file reads the payload from disk', async () => {
    writeFileSync(join(tmp, 'event.json'), JSON.stringify({ body: { ticket: 'T-7' } }));
    const result = await runCli(
      ['triggers', 'fire', 'tickets', '--payload', '@event.json', '--dry-run', '--json', '--project', PROJECT],
      writeConfig(startRunsServer()),
    );
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out).toMatchObject({ dry_run: true, rendered_prompt: 'Ticket T-1 from manual', filter_matches: false, session_key: 'T-1' });
    expect(sent('POST', '/tickets/fire')[0]!.body).toEqual({ dry_run: true, payload: { body: { ticket: 'T-7' } } });
  });

  test('fire --payload without --dry-run sends {payload}; a non-object payload exits 2 with no HTTP call', async () => {
    const apiConfig = writeConfig(startRunsServer());
    const result = await runCli(
      ['triggers', 'fire', 'tickets', '--payload', '{"body":{"ticket":"T-3"}}', '--wait', '0', '--project', PROJECT],
      apiConfig,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`Queued tickets → run ${NEW_RUN_ID}`);
    expect(sent('POST', '/tickets/fire').map((r) => r.body)).toEqual([{ payload: { body: { ticket: 'T-3' } } }]);
    for (const bad of ['[1]', 'not json', '@missing.json']) {
      const r = await runCli(['triggers', 'fire', 'tickets', '--payload', bad, '--dry-run', '--project', PROJECT], apiConfig);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--payload');
    }
    expect(sent('POST', '/tickets/fire')).toHaveLength(1);
  });

  test('replay posts {} and prints the new run; --confirm-unverified posts confirm_unverified', async () => {
    const apiConfig = writeConfig(startRunsServer());
    const plain = await runCli(['triggers', 'replay', 'tickets', RUN_ID, '--project', PROJECT], apiConfig);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain(`run ${RUN_ID} → run ${NEW_RUN_ID}`);
    const confirmed = await runCli(['triggers', 'replay', 'tickets', RUN_ID, '--confirm-unverified', '--project', PROJECT], apiConfig);
    expect(confirmed.code).toBe(0);
    expect(sent('POST', `/tickets/runs/${RUN_ID}/replay`).map((r) => r.body)).toEqual([{}, { confirm_unverified: true }]);
  });

  test('replay of an unverified run → 409: exit 1 with a message that names --confirm-unverified', async () => {
    replayAnswer = { status: 409, body: { error: 'payload is unverified', code: 'payload_unverified' } };
    const result = await runCli(['triggers', 'replay', 'tickets', RUN_ID, '--project', PROJECT], writeConfig(startRunsServer()));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--confirm-unverified');
  });

  test('replay of a run still in progress → 409 run_in_progress: exit 1 with its own message', async () => {
    replayAnswer = { status: 409, body: { error: 'run in progress', code: 'run_in_progress' } };
    const result = await runCli(['triggers', 'replay', 'tickets', RUN_ID, '--project', PROJECT], writeConfig(startRunsServer()));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is still in progress');
    expect(result.stderr).not.toContain('--confirm-unverified');
  });

  test('replay of a truncated payload → 422: exit 1 with the reason; a missing run id exits 2', async () => {
    replayAnswer = { status: 422, body: { error: 'payload truncated', code: 'payload_truncated' } };
    const apiConfig = writeConfig(startRunsServer());
    const result = await runCli(['triggers', 'replay', 'tickets', RUN_ID, '--project', PROJECT], apiConfig);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('64 KiB');
    const noId = await runCli(['triggers', 'replay', 'tickets', '--project', PROJECT], apiConfig);
    expect(noId.code).toBe(2);
  });
});

describe('kortix triggers add --apply — the webhook-secret 409 and the signing pointer', () => {
  const base = `/v1/projects/${PROJECT}/triggers`;
  const WEBHOOK_SECRET_409 = {
    error: 'Webhook secret is not available to the connector consumer',
    code: 'webhook_secret_delivery_mismatch',
    remediation:
      'Secret DOGFOOD_SECRET is stored with runtime scope; the webhook fires only with connector scope. Re-store it: kortix secrets set DOGFOOD_SECRET=<value> --scope connector.',
  };
  const WEBHOOK_URL = 'https://api.kortix.test/v1/webhooks/projects/proj_hook/dogfood-hook';
  const CREATED_WEBHOOK: typeof WEBHOOK_TRIGGER = {
    ...WEBHOOK_TRIGGER,
    slug: 'dogfood-hook',
    secret_env: 'DOGFOOD_SECRET',
    webhook_url: WEBHOOK_URL,
  };
  let addAnswer: { status: number; body: unknown };

  function startAddServer(): string {
    server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === base && req.method === 'POST') {
          return Response.json(addAnswer.body, { status: addAnswer.status });
        }
        return Response.json({ error: 'not found' }, { status: 404 });
      },
    });
    return `http://127.0.0.1:${server.port}`;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-add-live-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    addAnswer = { status: 409, body: WEBHOOK_SECRET_409 };
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  const addHook = (apiConfig: string) =>
    runCli(
      [
        'triggers',
        'add',
        'dogfood-hook',
        '--type',
        'webhook',
        '--secret-env',
        'DOGFOOD_SECRET',
        '--prompt',
        'A webhook arrived: {{ body.run }}',
        '--apply',
        '--project',
        PROJECT,
      ],
      apiConfig,
    );

  test('a webhook-secret 409 surfaces the server remediation naming the scope fix', async () => {
    // The API's 409 body carries a remediation field naming the exact
    // re-store command. The CLI used to print only "HTTP 409: <error>" and
    // dropped it — an opaque 409 that sent the reader into `secrets --help`
    // to find the fix.
    const result = await addHook(writeConfig(startAddServer()));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`HTTP 409: ${WEBHOOK_SECRET_409.error}`);
    expect(result.stderr).toContain('kortix secrets set DOGFOOD_SECRET=<value> --scope connector');
  });

  test('a created webhook trigger prints the signing scheme next to the URL, not the bare URL', async () => {
    // A bare URL is unsigned and unusable; the add output must name the
    // signing header and where the signed sample lives (`triggers info`).
    addAnswer = { status: 201, body: { triggers: [CREATED_WEBHOOK] } };
    const result = await addHook(writeConfig(startAddServer()));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(WEBHOOK_URL);
    expect(result.stdout).toContain('X-Kortix-Signature');
    expect(result.stdout).toContain('triggers info dogfood-hook');
  });
});

describe('kortix triggers — app triggers', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-'));
    process.env = { ...ORIGINAL_ENV };
    writeManifest();
    config = writeConfig('http://127.0.0.1:1');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('help documents the app type and --app', async () => {
    const result = await runCli(['triggers', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('App options (--type app)');
    expect(result.stdout).toContain('$KORTIX_APP_EVENTS_URL');
  });

  test('add writes an app trigger block to kortix.yaml', async () => {
    const result = await runCli(['triggers', 'add', 'bank-reply', '--type', 'app', '--app', 'bank-replies', '--prompt', 'Reply: {{ event.data.subject }}']);
    expect(result.code).toBe(0);
    const text = manifestText();
    expect(text).toMatch(/event: ["']?\*["']?/);
    expect(text).toContain('app: bank-replies');
    expect(text).toContain('prompt: "Reply: {{ event.data.subject }}"');
    expect(text).not.toContain('cron:');
    expect(text).not.toContain('timezone:');
  });

  test('add writes an every schedule that calls an App, with no prompt', async () => {
    const result = await runCli(['triggers', 'add', 'poll-bank', '--type', 'cron', '--every', '5m', '--target-app', 'bank-watcher', '--target-path', '/tick']);
    expect(result.code).toBe(0);
    const text = manifestText();
    expect(text).toContain('every: 5m');
    expect(text).toContain('app: bank-watcher');
    expect(text).toContain('path: /tick');
    expect(text).not.toContain('cron:');
    expect(text).not.toContain('prompt:');
  });

  test('add refuses --every with --cron, --every on a webhook, and --target-path alone', async () => {
    const both = await runCli(['triggers', 'add', 'a', '--type', 'cron', '--every', '5m', '--cron', '0 0 9 * * *', '--prompt', 'x']);
    expect([both.code, both.stderr.includes('--every, --cron and --run-at are exclusive')]).toEqual([2, true]);
    const webhook = await runCli(['triggers', 'add', 'b', '--type', 'webhook', '--secret-env', 'S', '--every', '5m', '--prompt', 'x']);
    expect([webhook.code, webhook.stderr.includes('--every is only valid on a cron trigger')]).toEqual([2, true]);
    const path = await runCli(['triggers', 'add', 'c', '--type', 'cron', '--cron', '0 0 9 * * *', '--target-path', '/x', '--prompt', 'x']);
    expect([path.code, path.stderr.includes('--target-path needs --target-app')]).toEqual([2, true]);
  });

  test('add refuses an app trigger without --app, with --cron, and --app on a cron trigger', async () => {
    const noApp = await runCli(['triggers', 'add', 'a', '--type', 'app', '--prompt', 'x']);
    expect([noApp.code, noApp.stderr.includes('app triggers need --app <slug>')]).toEqual([2, true]);
    const withCron = await runCli(['triggers', 'add', 'b', '--type', 'app', '--app', 'w', '--cron', '0 0 9 * * *', '--prompt', 'x']);
    expect([withCron.code, withCron.stderr.includes('--cron is not valid on an app trigger')]).toEqual([2, true]);
    const cronWithApp = await runCli(['triggers', 'add', 'c', '--type', 'cron', '--cron', '0 0 9 * * *', '--app', 'w', '--prompt', 'x']);
    expect([cronWithApp.code, cronWithApp.stderr.includes('--app is only valid on an app trigger')]).toEqual([2, true]);
    expect(manifestText()).not.toContain('slug: a');
  });
});
