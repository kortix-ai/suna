/**
 * `teams history` / `teams thread`, run as the REAL CLI process — through the
 * real `kortix connectors call` — against a fake API that serves Graph-shaped
 * messages. Modeled on e2e-slack-cli.test.ts.
 *
 * A Slack agent reads what was said before it was mentioned; a Teams agent
 * could not. In a channel the bot acts only on mentions, so the discussion it
 * is asked about was never in its session.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI_ENTRY = resolve(REPO_ROOT, 'apps/sandbox/slack-cli/channels/teams.ts');
const CONNECTOR_CLI_ENTRY = resolve(REPO_ROOT, 'apps/cli/src/index.ts');

const PROJECT = 'proj-teams-cli';
const TOKEN = 'kortix_test_teams_cli';
const CHANNEL = '19:synthetic-channel@thread.tacv2';
const ROOT = '1789730833598';

let calls: Array<{ action: string; args: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve>;
let apiUrl = '';

const msg = (id: string, at: string, who: string, html: string, extra: Record<string, unknown> = {}) => ({
  id,
  createdDateTime: at,
  messageType: 'message',
  from: { user: { displayName: who } },
  body: { contentType: 'html', content: html },
  ...extra,
});

function graphFor(action: string): unknown {
  switch (action) {
    case 'list_messages':
      // Graph returns newest first; the CLI must put them in reading order.
      return {
        value: [
          msg('3', '2026-09-22T10:02:00Z', 'Ana', '<p>Newest</p>'),
          msg('2', '2026-09-22T10:01:00Z', 'Ivan', '<p>Middle &amp; more</p>'),
          msg('1', '2026-09-22T10:00:00Z', 'Ana', '<p>Oldest</p>'),
          { id: 's1', createdDateTime: '2026-09-22T09:59:00Z', messageType: 'systemEventMessage', body: { content: '<systemEventMessage/>' } },
        ],
      };
    case 'get_message':
      return msg(ROOT, '2026-09-22T09:00:00Z', 'Ana', '<p>Is the deploy blocked?</p>');
    case 'list_replies':
      return {
        value: [
          msg('r2', '2026-09-22T09:05:00Z', 'Ivan', '<p><at id="0">Kortix</at> can you check?</p>'),
          msg('r1', '2026-09-22T09:02:00Z', 'Marko', '<p>Looks like the migration.</p>'),
          msg('rd', '2026-09-22T09:03:00Z', 'Marko', '<p>oops</p>', { deletedDateTime: '2026-09-22T09:04:00Z' }),
        ],
      };
    default:
      return {};
  }
}

async function runTeams(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      KORTIX_API_URL: apiUrl,
      KORTIX_TOKEN: TOKEN,
      KORTIX_PROJECT_ID: PROJECT,
      KORTIX_SESSION_ID: 'sess-teams-cli',
      KORTIX_CLI_BIN: CONNECTOR_CLI_ENTRY,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const text = (stdout.trim() || stderr.trim());
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { exitCode, body };
}

beforeEach(() => {
  calls = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.pathname === `/v1/connectors/projects/${PROJECT}/call`) {
        const body = (await req.json()) as { connector: string; action: string; args?: Record<string, unknown> };
        calls.push({ action: body.action, args: body.args ?? {} });
        return Response.json({ ok: true, data: graphFor(body.action), risk: 'read' });
      }
      return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

const inChannelThread = {
  MS_TEAMS_CONVERSATION_ID: `${CHANNEL};messageid=${ROOT}`,
  MS_TEAMS_TEAM_GROUP_ID: 'team-aad-1',
};

describe('teams thread', () => {
  test('reads the thread the agent was mentioned in: root first, then replies, in order', async () => {
    const { exitCode, body } = await runTeams(['thread'], inChannelThread);

    expect(exitCode).toBe(0);
    expect(body.thread).toBe(ROOT);
    expect(body.messages.map((m: any) => m.text)).toEqual([
      'Is the deploy blocked?',
      'Looks like the migration.',
      '@Kortix can you check?',
    ]);
    expect(body.messages.map((m: any) => m.from)).toEqual(['Ana', 'Marko', 'Ivan']);
  });

  test('every id comes from the session`s own env — the agent passes nothing', async () => {
    await runTeams(['thread'], inChannelThread);

    const expected = { 'team-id': 'team-aad-1', 'channel-id': CHANNEL, 'message-id': ROOT };
    expect(calls.map((c) => c.action).sort()).toEqual(['get_message', 'list_replies']);
    for (const c of calls) expect(c.args).toEqual(expected);
  });

  test('a deleted reply is not read back as if it were said', async () => {
    const { body } = await runTeams(['thread'], inChannelThread);
    expect(body.messages.some((m: any) => m.text === 'oops')).toBe(false);
  });

  test('--limit keeps the most recent messages', async () => {
    const { body } = await runTeams(['thread', '--limit', '2'], inChannelThread);
    expect(body.messages.map((m: any) => m.text)).toEqual(['Looks like the migration.', '@Kortix can you check?']);
  });
});

describe('teams history', () => {
  test('reads the channel, oldest first, without system events, entities decoded', async () => {
    const { exitCode, body } = await runTeams(['history'], inChannelThread);

    expect(exitCode).toBe(0);
    expect(body.messages.map((m: any) => m.text)).toEqual(['Oldest', 'Middle & more', 'Newest']);
    expect(calls).toEqual([{ action: 'list_messages', args: { 'team-id': 'team-aad-1', 'channel-id': CHANNEL } }]);
  });
});

describe('outside a channel, it says so instead of failing obscurely', () => {
  test('a personal chat is refused with the reason, and calls nothing', async () => {
    const { exitCode, body } = await runTeams(['thread'], { MS_TEAMS_CONVERSATION_ID: 'a:synthetic-personal-chat' });

    expect(exitCode).not.toBe(0);
    expect(JSON.stringify(body)).toContain('NOT_A_CHANNEL');
    expect(calls).toEqual([]);
  });

  test('a group chat (@thread.v2) is not a channel either', async () => {
    const { exitCode } = await runTeams(['history'], { MS_TEAMS_CONVERSATION_ID: '19:abc@thread.v2' });
    expect(exitCode).not.toBe(0);
    expect(calls).toEqual([]);
  });

  test('a channel with no team id says which variable is missing', async () => {
    const { exitCode, body } = await runTeams(['history'], { MS_TEAMS_CONVERSATION_ID: `${CHANNEL};messageid=${ROOT}` });

    expect(exitCode).not.toBe(0);
    expect(JSON.stringify(body)).toContain('MS_TEAMS_TEAM_GROUP_ID');
  });

  test('`thread` on the channel itself (no thread) points at `history`', async () => {
    const { exitCode, body } = await runTeams(['thread'], {
      MS_TEAMS_CONVERSATION_ID: CHANNEL,
      MS_TEAMS_TEAM_GROUP_ID: 'team-aad-1',
    });

    expect(exitCode).not.toBe(0);
    expect(JSON.stringify(body)).toContain('teams history');
  });
});
