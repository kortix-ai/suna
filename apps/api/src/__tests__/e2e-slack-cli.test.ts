/**
 * End-to-end coverage for the in-sandbox `slack` CLI surface. The test runs the
 * real Bun entrypoint against a live fake Kortix API so command parsing,
 * project-explicit Executor routing, turn-stream relays, file upload/download,
 * and manifest fetching are all exercised without touching real Slack.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLACK_CHANNEL_CONNECTOR_SLUG } from '../executor/channels';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI_ENTRY = resolve(REPO_ROOT, 'apps/sandbox/slack-cli/channels/slack.ts');

const PROJECT = 'proj-slack-cli';
const SESSION = 'sess-slack-cli';
const TOKEN = 'kortix_test_slack_cli';

interface World {
  executor: Array<{ connector: string; action: string; args: Record<string, unknown> }>;
  turns: Array<Record<string, unknown>>;
  uploads: Array<Record<string, unknown>>;
  downloads: string[];
  manifests: string[];
  reservedFailure: null | 'connector_not_found' | 'action_not_found' | 'needs_auth';
}

let world: World;
let server: ReturnType<typeof Bun.serve>;
let apiUrl: string;
let tempDir: string;

type CliObject = Record<string, unknown>;
type CliOutput = CliObject | string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function slackDataFor(action: string, args: Record<string, unknown>): unknown {
  switch (action) {
    case 'send_message':
      return { ok: true, ts: '111.222', channel: args.channel };
    case 'update_message':
      return { ok: true, ts: args.ts, channel: args.channel };
    case 'delete_message':
    case 'add_reaction':
      return { ok: true };
    case 'get_history':
      return { ok: true, messages: [{ type: 'message', text: 'history', channel: args.channel }] };
    case 'get_thread':
      return {
        ok: true,
        messages: [
          { type: 'message', text: 'root', ts: args.ts },
          { type: 'message', text: 'reply' },
        ],
      };
    case 'list_channels':
      return { ok: true, channels: [{ id: 'C1', name: 'general' }] };
    case 'channel_info':
      return { ok: true, channel: { id: args.channel, name: 'incidents' } };
    case 'join_channel':
      return { ok: true, channel: { id: args.channel, name: 'joined' } };
    case 'list_users':
      return { ok: true, members: [{ id: 'U1', name: 'alice' }] };
    case 'user_info':
      return { ok: true, user: { id: args.user, name: 'alice' } };
    case 'auth_test':
      return {
        ok: true,
        user_id: 'Ubot',
        user: 'kortix',
        team: 'Kortix',
        team_id: 'T1',
        bot_id: 'B1',
      };
    case 'search_messages':
      return { ok: true, messages: { matches: [{ text: 'hit', channel: { id: 'C1' } }] } };
    case 'file_info':
      return { ok: true, file: { id: args.file, name: 'report.md' } };
    default:
      return { ok: false, error: `unhandled_test_action:${action}` };
  }
}

function asObject(value: CliOutput): CliObject {
  expect(typeof value).toBe('object');
  return value as CliObject;
}

async function runSlack(args: string[], opts: { ok?: boolean } = {}): Promise<CliOutput> {
  const expectOk = opts.ok ?? true;
  const proc = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      KORTIX_API_URL: apiUrl,
      KORTIX_CLI_TOKEN: TOKEN,
      KORTIX_PROJECT_ID: PROJECT,
      KORTIX_SESSION_ID: SESSION,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe('');
  if (expectOk) expect(exitCode).toBe(0);
  else expect(exitCode).not.toBe(0);

  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  return JSON.parse(trimmed);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'kortix-slack-cli-test-'));
  world = {
    executor: [],
    turns: [],
    uploads: [],
    downloads: [],
    manifests: [],
    reservedFailure: null,
  };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return json({ error: 'unauthorized' }, 401);
      }

      if (url.pathname === `/v1/projects/${PROJECT}/turn-stream`) {
        const body = (await req.json()) as Record<string, unknown>;
        world.turns.push(body);
        return json({ ok: true });
      }

      if (url.pathname === `/v1/executor/projects/${PROJECT}/call`) {
        const body = (await req.json()) as {
          connector: string;
          action: string;
          args?: Record<string, unknown>;
        };
        const call = { connector: body.connector, action: body.action, args: body.args ?? {} };
        world.executor.push(call);
        if (body.connector === SLACK_CHANNEL_CONNECTOR_SLUG && world.reservedFailure) {
          return json(
            { ok: false, status: 'denied', reason: world.reservedFailure },
            world.reservedFailure === 'needs_auth' ? 403 : 404,
          );
        }
        if (body.connector !== SLACK_CHANNEL_CONNECTOR_SLUG && body.connector !== 'slack') {
          return json({ ok: false, status: 'denied', reason: 'connector_not_found' }, 404);
        }
        return json({ ok: true, data: slackDataFor(body.action, body.args ?? {}), risk: 'read' });
      }

      if (url.pathname === `/v1/projects/${PROJECT}/channels/slack/file/upload`) {
        const body = (await req.json()) as Record<string, unknown>;
        world.uploads.push(body);
        return json({ ok: true, files: [{ id: 'F1', name: body.filename }] });
      }

      if (url.pathname === `/v1/projects/${PROJECT}/channels/slack/file`) {
        world.downloads.push(url.searchParams.get('url') ?? '');
        return new Response('downloaded from slack', { status: 200 });
      }

      if (url.pathname === `/v1/webhooks/slack/${PROJECT}/manifest`) {
        world.manifests.push(url.searchParams.get('name') ?? '');
        return json({ display_information: { name: url.searchParams.get('name') ?? 'Kortix' } });
      }

      return json({ error: `unexpected ${url.pathname}` }, 404);
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('slack CLI', () => {
  test('maps every Slack Web API command to the reserved channel connector', async () => {
    const cases: Array<{
      args: string[];
      action: string;
      expectedArgs: Record<string, unknown>;
      expectOutput?: Record<string, unknown>;
    }> = [
      {
        args: ['send', '--channel', 'C1', '--text', 'hi', '--thread', '123.45'],
        action: 'send_message',
        expectedArgs: { channel: 'C1', mrkdwn: true, text: 'hi', thread_ts: '123.45' },
        expectOutput: { ts: '111.222', channel: 'C1' },
      },
      {
        args: ['edit', '--channel', 'C1', '--ts', '111.222', '--text', 'updated'],
        action: 'update_message',
        expectedArgs: { channel: 'C1', ts: '111.222', text: 'updated' },
      },
      {
        args: ['delete', '--channel', 'C1', '--ts', '111.222'],
        action: 'delete_message',
        expectedArgs: { channel: 'C1', ts: '111.222' },
      },
      {
        args: ['react', '--channel', 'C1', '--ts', '111.222', '--emoji', 'white_check_mark'],
        action: 'add_reaction',
        expectedArgs: { channel: 'C1', timestamp: '111.222', name: 'white_check_mark' },
      },
      {
        args: ['history', '--channel', 'C1', '--limit', '3'],
        action: 'get_history',
        expectedArgs: { channel: 'C1', limit: '3' },
      },
      {
        args: ['thread', '--channel', 'C1', '--ts', '111.222', '--limit', '2'],
        action: 'get_thread',
        expectedArgs: { channel: 'C1', ts: '111.222', limit: '2' },
      },
      {
        args: ['channels', '--limit', '4'],
        action: 'list_channels',
        expectedArgs: {
          limit: '4',
          types: 'public_channel,private_channel',
          exclude_archived: 'true',
        },
      },
      {
        args: ['channel-info', '--channel', 'C1'],
        action: 'channel_info',
        expectedArgs: { channel: 'C1' },
      },
      {
        args: ['join', '--channel', 'C1'],
        action: 'join_channel',
        expectedArgs: { channel: 'C1' },
      },
      { args: ['users', '--limit', '5'], action: 'list_users', expectedArgs: { limit: '5' } },
      { args: ['user', '--id', 'U1'], action: 'user_info', expectedArgs: { user: 'U1' } },
      { args: ['me'], action: 'auth_test', expectedArgs: {} },
      {
        args: ['search', '--query', 'from:@marko'],
        action: 'search_messages',
        expectedArgs: { query: 'from:@marko' },
      },
      { args: ['file-info', '--file', 'F1'], action: 'file_info', expectedArgs: { file: 'F1' } },
    ];

    for (const c of cases) {
      world.executor = [];
      const out = asObject(await runSlack(c.args));
      expect(out.ok).toBe(true);
      if (c.expectOutput) expect(out).toMatchObject(c.expectOutput);
      expect(world.executor).toHaveLength(1);
      expect(world.executor[0]).toEqual({
        connector: SLACK_CHANNEL_CONNECTOR_SLUG,
        action: c.action,
        args: c.expectedArgs,
      });
    }
  });

  test('covers non-Executor commands: help, typing, turn stream, file upload/download, manifest', async () => {
    expect(String(await runSlack(['help']))).toContain('slack — Slack Web API adapter');

    const typing = asObject(await runSlack(['typing', '--channel', 'C1']));
    expect(typing.ok).toBe(true);
    expect(String(typing.note)).toContain('typing indicators');
    expect(world.executor).toHaveLength(0);

    const step = asObject(
      await runSlack([
        'step',
        'Reading logs',
        '--detail',
        'Last hour',
        '--output',
        '2 errors',
        '--source',
        'https://example.com/logs|Logs',
      ]),
    );
    expect(step).toMatchObject({ ok: true, relayed: true });
    expect(world.turns.at(-1)).toMatchObject({
      session_id: SESSION,
      kind: 'step',
      text: 'Reading logs',
      detail: 'Last hour',
      output: '2 errors',
    });
    expect(world.turns.at(-1)?.sources).toEqual([
      { url: 'https://example.com/logs', text: 'Logs' },
    ]);

    const answer = asObject(
      await runSlack([
        'send',
        '--text',
        'Done',
        '--blocks',
        '[{"type":"section","text":{"type":"mrkdwn","text":"*Done*"}}]',
      ]),
    );
    expect(answer).toMatchObject({ ok: true, delivered: 'stream', mode: 'blocks' });
    expect(world.turns.at(-1)).toMatchObject({ session_id: SESSION, kind: 'answer', text: 'Done' });

    const uploadPath = join(tempDir, 'report.txt');
    writeFileSync(uploadPath, 'hello slack');
    const uploaded = asObject(
      await runSlack([
        'send',
        '--channel',
        'C1',
        '--thread',
        '111.222',
        '--file',
        uploadPath,
        '--text',
        'Report',
      ]),
    );
    expect(uploaded).toMatchObject({ ok: true, channel: 'C1' });
    expect(world.uploads[0]).toMatchObject({
      channel: 'C1',
      filename: 'report.txt',
      comment: 'Report',
      thread_ts: '111.222',
    });
    expect(Buffer.from(String(world.uploads[0]?.content_base64), 'base64').toString()).toBe(
      'hello slack',
    );

    const downloadPath = join(tempDir, 'download.txt');
    const downloaded = asObject(
      await runSlack(['download', '--url', 'https://files.slack.com/F1', '--out', downloadPath]),
    );
    expect(downloaded).toMatchObject({ ok: true, path: downloadPath, size: 21 });
    expect(readFileSync(downloadPath, 'utf8')).toBe('downloaded from slack');
    expect(world.downloads).toEqual(['https://files.slack.com/F1']);

    const manifest = asObject(await runSlack(['manifest', '--name', 'Test Slack App']));
    expect(manifest).toMatchObject({
      ok: true,
      manifest: { display_information: { name: 'Test Slack App' } },
    });
    expect(world.manifests).toEqual(['Test Slack App']);
  });

  test('falls back to legacy slack only while the reserved channel connector rolls out', async () => {
    world.reservedFailure = 'action_not_found';
    const out = asObject(await runSlack(['thread', '--channel', 'C1', '--ts', '111.222']));
    expect(out.ok).toBe(true);
    expect(world.executor.map((c) => `${c.connector}.${c.action}`)).toEqual([
      `${SLACK_CHANNEL_CONNECTOR_SLUG}.get_thread`,
      'slack.get_thread',
    ]);
  });

  test('does not fall back to a user-defined slack connector when the reserved channel needs auth', async () => {
    world.reservedFailure = 'needs_auth';
    const out = asObject(
      await runSlack(['thread', '--channel', 'C1', '--ts', '111.222'], { ok: false }),
    );
    expect(out).toMatchObject({ ok: false, error: 'needs_auth' });
    expect(world.executor.map((c) => `${c.connector}.${c.action}`)).toEqual([
      `${SLACK_CHANNEL_CONNECTOR_SLUG}.get_thread`,
    ]);
  });
});
