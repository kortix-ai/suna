import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const ORIGINAL_ENV = { ...process.env };
const PROJECT = 'proj_triggers';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let tmp: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let calls: Call[] = [];
let eventStatus = 'needs_connection';
let eventError: string | null = null;
let currentEventConfig: Record<string, unknown> = { owner: 'acme', repo: 'app' };

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
          limit: { type: 'integer', description: 'Max items' },
          draft: { type: 'boolean' },
          labels: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['open', 'closed'] },
        },
        required: ['owner'],
      },
      payload_schema: null,
    },
  ],
};

const eventRow = (slug: string, config: Record<string, unknown>) => ({
  slug,
  type: 'event',
  cron: null,
  event: {
    connector: 'github',
    type: 'GITHUB_PULL_REQUEST_EVENT',
    config,
    provider: 'composio',
    app: 'github',
    status: eventStatus,
    error: eventError,
    last_event_at: null,
  },
});

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

function triggerList(overrides: Record<string, unknown> = {}) {
  return {
    triggers: [
      {
        slug: 'digest',
        name: 'Daily digest',
        type: 'cron',
        agent: 'default',
        model: null,
        enabled: true,
        prompt_template: 'Summarize yesterday',
        cron: '0 0 9 * * 1-5',
        run_at: null,
        timezone: 'UTC',
        secret_env: null,
        webhook_url: null,
        last_fired_at: null,
        event: null,
        ...overrides,
      },
    ],
    triggers_paused: false,
    errors: [],
  };
}

function startServer(timezone = 'UTC'): string {
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: url.pathname + url.search, body });
      const base = `/v1/projects/${PROJECT}/triggers`;

      if (url.pathname === `${base}/event-types`) return Response.json(EVENT_TYPES);
      if (url.pathname === base && req.method === 'GET') {
        return Response.json(triggerList(eventRow('new-pr', currentEventConfig)));
      }
      if (url.pathname === `${base}/new-pr` && req.method === 'PATCH') {
        return Response.json(triggerList(eventRow('new-pr', (body as { event_config?: Record<string, unknown> }).event_config ?? currentEventConfig)));
      }
      if (url.pathname === base && req.method === 'POST') {
        const draft = body as Record<string, unknown>;
        if (draft.type === 'event') {
          return Response.json(triggerList(eventRow(String(draft.slug), draft.event_config as Record<string, unknown>)), { status: 201 });
        }
        if (draft.type === 'webhook') {
          return Response.json(
            triggerList({
              slug: String(draft.slug),
              type: 'webhook',
              cron: null,
              secret_env: String(draft.secret_env),
              webhook_url: 'https://api.test/v1/webhooks/projects/p/hook',
            }),
            { status: 201 },
          );
        }
        return Response.json(triggerList({ slug: String(draft.slug) }), { status: 201 });
      }
      if (url.pathname === `${base}/digest` && req.method === 'PATCH') {
        return Response.json(triggerList({ timezone }));
      }
      if (url.pathname === `${base}/digest` && req.method === 'DELETE') {
        return Response.json({ triggers: [], triggers_paused: false, errors: [] });
      }
      if (url.pathname === `${base}/gone` && req.method === 'PATCH') {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

async function runCli(args: string[], configFile?: string) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    KORTIX_CONFIG_FILE: configFile,
  };
  for (const key of ['KORTIX_API_URL', 'KORTIX_CLI_TOKEN', 'KORTIX_FRONTEND_URL', 'KORTIX_PROJECT_ID', 'KORTIX_TOKEN', 'BASH_ENV']) {
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

describe('kortix triggers — the live (--apply) path', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-triggers-'));
    process.env = { ...ORIGINAL_ENV };
    calls = [];
    eventStatus = 'needs_connection';
    eventError = null;
  });

  afterEach(() => {
    server?.stop(true);
    server = null;
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  test('--help documents --apply, set, and every live-only flag', async () => {
    const r = await runCli(['triggers', '--help']);
    expect(r.code).toBe(0);
    for (const fragment of ['set <slug>', '--run-at <iso>', '--session-mode <m>', '--session-key <tmpl>', '--session-access <mode>', '--filter <path=value>', '--enabled true|false']) {
      expect(r.stdout).toContain(fragment);
    }
  });

  test('add --apply POSTs the full cron body', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'digest', '--apply', '--type', 'cron', '--cron', '0 0 9 * * 1-5', '--timezone', 'Europe/Berlin', '--prompt', 'Summarize yesterday', '--agent', 'writer', '--model', 'anthropic/claude', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: `/v1/projects/${PROJECT}/triggers`,
      body: {
        slug: 'digest',
        name: 'digest',
        type: 'cron',
        prompt_template: 'Summarize yesterday',
        enabled: true,
        agent: 'writer',
        model: 'anthropic/claude',
        cron: '0 0 9 * * 1-5',
        timezone: 'Europe/Berlin',
      },
    });
    expect(r.stdout).toContain('digest (cron) live on the project');
  });

  test('add --apply --type event POSTs connector, event, and event_config', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'new-pr', '--apply', '--type', 'event', '--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT', '--config', 'owner=acme', '--config-json', '{"draft":false}', '--prompt', 'Review {{ event.data.title }}', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      slug: 'new-pr',
      name: 'new-pr',
      type: 'event',
      prompt_template: 'Review {{ event.data.title }}',
      enabled: true,
      connector: 'github',
      event: 'GITHUB_PULL_REQUEST_EVENT',
      event_config: { draft: false, owner: 'acme' },
    });
    expect(r.stdout).toContain('new-pr (event) added to the project');
    expect(r.stdout).toContain('kortix connectors connect github --owner project');
    expect(r.stdout).toContain('A person must open the link');
  });

  const addEvent = (config: string, ...extra: string[]) =>
    runCli(
      ['triggers', 'add', 'new-pr', '--apply', '--type', 'event', '--connector', 'github', '--event', 'GITHUB_PULL_REQUEST_EVENT', '--prompt', 'p', '--project', PROJECT, ...extra],
      config,
    );
  const postBody = () => calls.find((c) => c.method === 'POST')?.body as Record<string, unknown> | undefined;

  test('add --apply converts --config values by the catalog schema', async () => {
    const config = writeConfig(startServer());
    const r = await addEvent(config, '--config', 'owner=acme', '--config', 'limit=5', '--config', 'draft=true', '--config', 'labels=bug, ui', '--config', 'state=open');
    expect(r.code).toBe(0);
    expect(postBody()?.event_config).toEqual({ owner: 'acme', limit: 5, draft: true, labels: ['bug', 'ui'], state: 'open' });
  });

  test('add --apply lists every invalid field and sends nothing', async () => {
    const config = writeConfig(startServer());
    const r = await addEvent(config, '--config', 'limit=abc', '--config', 'state=merged');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('limit must be an integer (got "abc")');
    expect(r.stderr).toContain('owner is required — Repository owner');
    expect(r.stderr).toContain('state must be one of open, closed');
    expect(postBody()).toBeUndefined();
  });

  test('add --apply rejects an unknown event with the events command', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'add', 'x', '--apply', '--type', 'event', '--connector', 'github', '--event', 'NOPE', '--prompt', 'p', '--project', PROJECT], config);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('Unknown event NOPE for github. Run `kortix triggers events --connector github`');
    expect(postBody()).toBeUndefined();
  });

  test('add --apply prints the next step per status', async () => {
    const config = writeConfig(startServer());
    eventStatus = 'active';
    const live = await addEvent(config, '--config', 'owner=acme');
    expect(live.stdout).toContain('Live. It fires on the next Pull request.');
    eventStatus = 'error';
    eventError = 'repo not found';
    const bad = await addEvent(config, '--config', 'owner=acme');
    expect(bad.stdout).toContain('Error: repo not found');
    expect(bad.stdout).toContain('kortix triggers set new-pr --config');
  });

  test('set --config merges into the current config', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', 'new-pr', '--config', 'limit=7', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ event_config: { owner: 'acme', repo: 'app', limit: 7 } });
  });

  test('set --config-json replaces the config', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', 'new-pr', '--config-json', '{"owner":"zed"}', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ event_config: { owner: 'zed' } });
  });

  test('set --config on a non-event trigger fails', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', 'digest', '--config', 'a=b', '--project', PROJECT], config);
    expect(r.code).not.toBe(0);
  });

  test('add --apply rejects event misuse before any request', async () => {
    const config = writeConfig(startServer());
    const base = ['triggers', 'add', 'x', '--apply', '--prompt', 'p', '--project', PROJECT];
    const cron = await runCli([...base, '--type', 'event', '--connector', 'github', '--event', 'E', '--cron', '0 0 9 * * *'], config);
    expect(cron.code).toBe(2);
    expect(cron.stderr).toContain('--cron is not valid on an event trigger');
    const stray = await runCli([...base, '--cron', '0 0 9 * * *', '--event', 'E'], config);
    expect(stray.code).toBe(2);
    expect(stray.stderr).toContain('--event is only valid on an event trigger');
    const missing = await runCli([...base, '--type', 'event', '--event', 'E'], config);
    expect(missing.code).toBe(2);
    expect(calls).toEqual([]);
  });

  test('add --apply --run-at sends a one-off instead of a cron', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'once', '--apply', '--run-at', '2026-03-01T09:00:00Z', '--prompt', 'Do it once', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    const sent = calls[0].body as Record<string, unknown>;
    expect(sent.run_at).toBe('2026-03-01T09:00:00Z');
    expect(sent.cron).toBeUndefined();
    expect(sent.timezone).toBe('UTC');
  });

  test('add --apply carries session wiring, access, and filters', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'hook', '--apply', '--type', 'webhook', '--secret-env', 'HOOK_SECRET', '--prompt', 'Handle {{ body.type }}', '--session-key', '{{ body.data.chat_jid }}', '--session-access', 'members', '--member', MEMBER, '--group', GROUP, '--filter', 'body.type=push', '--filter', 'body.ref=refs/heads/main', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect(calls[0].body).toEqual({
      slug: 'hook',
      name: 'hook',
      type: 'webhook',
      prompt_template: 'Handle {{ body.type }}',
      enabled: true,
      session_key: '{{ body.data.chat_jid }}',
      session_access: { mode: 'members', memberIds: [MEMBER], groupIds: [GROUP] },
      filter: { 'body.type': 'push', 'body.ref': 'refs/heads/main' },
      secret_env: 'HOOK_SECRET',
    });
    expect(r.stdout).toContain('https://api.test/v1/webhooks/projects/p/hook');
  });

  test('--member alone implies session_access members', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'x', '--apply', '--cron', '0 0 * * * *', '--prompt', 'p', '--member', MEMBER, '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(0);
    expect((calls[0].body as any).session_access).toEqual({ mode: 'members', memberIds: [MEMBER], groupIds: [] });
  });

  test('--member with a non-members access mode is refused before the request', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'x', '--apply', '--cron', '0 0 * * * *', '--prompt', 'p', '--session-access', 'project', '--member', MEMBER, '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--session-access members');
    expect(calls).toEqual([]);
  });

  test('add --apply rejects --cron with --run-at', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(
      ['triggers', 'add', 'x', '--apply', '--cron', '0 0 * * * *', '--run-at', '2026-03-01T09:00:00Z', '--prompt', 'p', '--project', PROJECT],
      config,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--cron and --run-at are exclusive');
    expect(calls).toEqual([]);
  });

  test('add --apply rejects a malformed --filter', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'add', 'x', '--apply', '--cron', '0 0 * * * *', '--prompt', 'p', '--filter', 'nope', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--filter must look like path=value');
    expect(calls).toEqual([]);
  });

  test('add WITHOUT --apply never touches the network', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'add', 'digest', '--cron', '0 0 9 * * 1-5', '--prompt', 'p', '--project', PROJECT], config);
    // No kortix.yaml in the temp dir, so the local edit fails — the point is
    // that the default path is still the manifest, not the API.
    expect(r.code).not.toBe(0);
    expect(calls).toEqual([]);
  });

  test('set PATCHes only the fields passed', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', 'digest', '--name', 'Weekday digest', '--agent', 'writer', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: `/v1/projects/${PROJECT}/triggers/digest`,
      body: { name: 'Weekday digest', agent: 'writer' },
    });
    expect(r.stdout).toContain('Updated digest');
  });

  test('set --cron nulls run_at, and set --run-at nulls cron', async () => {
    const config = writeConfig(startServer('Europe/Berlin'));
    const toCron = await runCli(['triggers', 'set', 'digest', '--cron', '0 0 7 * * *', '--project', PROJECT], config);
    expect(toCron.code).toBe(0);
    expect(calls[0].body).toEqual({ cron: '0 0 7 * * *', run_at: null });

    calls = [];
    const toOnce = await runCli(['triggers', 'set', 'digest', '--run-at', '2026-03-01T09:00:00Z', '--timezone', 'Europe/Berlin', '--project', PROJECT], config);
    expect(toOnce.code).toBe(0);
    expect(calls[0].body).toEqual({ run_at: '2026-03-01T09:00:00Z', cron: null, timezone: 'Europe/Berlin' });
  });

  test.each([
    ['--cron', '0 0 7 * * *', { cron: '0 0 7 * * *', run_at: null }],
    ['--run-at', '2026-03-01T09:00:00Z', { run_at: '2026-03-01T09:00:00Z', cron: null }],
  ])('set %s preserves an omitted timezone and accepts an explicit timezone', async (flag, schedule, body) => {
    const config = writeConfig(startServer('Europe/Berlin'));
    const omitted = await runCli(['triggers', 'set', 'digest', flag, schedule, '--project', PROJECT], config);
    expect(omitted.code).toBe(0);
    expect(omitted.stderr).not.toContain('error:');
    expect(calls[0].body).toEqual(body);

    calls = [];
    const explicit = await runCli(['triggers', 'set', 'digest', flag, schedule, '--timezone', 'Europe/Berlin', '--project', PROJECT], config);
    expect(explicit.code).toBe(0);
    expect(calls[0].body).toEqual({ ...body, timezone: 'Europe/Berlin' });
  });

  test('set --timezone updates only the timezone, including explicit UTC', async () => {
    const config = writeConfig(startServer('Europe/Berlin'));
    const r = await runCli(['triggers', 'set', 'digest', '--timezone', 'UTC', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0].body).toEqual({ timezone: 'UTC' });
  });

  test('set --enabled maps to a boolean and rejects anything else', async () => {
    const config = writeConfig(startServer());
    const ok = await runCli(['triggers', 'set', 'digest', '--enabled', 'false', '--project', PROJECT], config);
    expect(ok.code).toBe(0);
    expect(calls[0].body).toEqual({ enabled: false });

    calls = [];
    const bad = await runCli(['triggers', 'set', 'digest', '--enabled', 'maybe', '--project', PROJECT], config);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--enabled must be true or false');
    expect(calls).toEqual([]);
  });

  test('set with no fields exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', 'digest', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('at least one field to change');
    expect(calls).toEqual([]);
  });

  test('set without a slug exits 2', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', '--name', 'x', '--project', PROJECT], config);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Pass a trigger slug');
  });

  test('set surfaces a 404 from the API', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'set', 'gone', '--name', 'x', '--project', PROJECT], config);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Not found');
  });

  test('enable/disable --apply PATCH {enabled}', async () => {
    const config = writeConfig(startServer());
    const off = await runCli(['triggers', 'disable', 'digest', '--apply', '--project', PROJECT], config);
    expect(off.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'PATCH',
      path: `/v1/projects/${PROJECT}/triggers/digest`,
      body: { enabled: false },
    });
    expect(off.stdout).toContain('Disabled digest');

    calls = [];
    const on = await runCli(['triggers', 'enable', 'digest', '--apply', '--project', PROJECT], config);
    expect(on.code).toBe(0);
    expect(calls[0].body).toEqual({ enabled: true });
  });

  test('rm --apply DELETEs the trigger', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'rm', 'digest', '--apply', '--project', PROJECT], config);
    expect(r.code).toBe(0);
    expect(calls[0]).toEqual({
      method: 'DELETE',
      path: `/v1/projects/${PROJECT}/triggers/digest`,
      body: null,
    });
    expect(r.stdout).toContain('Removed digest');
  });

  test('rm --apply --json emits the remaining list', async () => {
    const config = writeConfig(startServer());
    const r = await runCli(['triggers', 'rm', 'digest', '--apply', '--project', PROJECT, '--json'], config);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).triggers).toEqual([]);
  });
});
