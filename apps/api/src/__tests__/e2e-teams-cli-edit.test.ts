/**
 * `teams edit` / `teams delete`, run as the REAL CLI process against a fake
 * API. Slack's agent could fix or remove a message it posted; a Teams agent
 * could only post again. Modeled on e2e-teams-cli-history.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI_ENTRY = resolve(REPO_ROOT, 'apps/sandbox/slack-cli/channels/teams.ts');
const PROJECT = 'proj-teams-cli';
const TOKEN = 'kortix_test_teams_cli';
const CONVERSATION = '19:synthetic-channel@thread.tacv2';
// Each test spawns the real CLI (a cold `bun` start); the 5 s default is too
// tight on a loaded machine, as e2e-slack-cli.test.ts found on CI.
const SPAWN_TIMEOUT_MS = 30_000;

let calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve>;
let apiUrl = '';

async function runTeams(args: string[]) {
  const proc = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', KORTIX_API_URL: apiUrl, KORTIX_TOKEN: TOKEN, KORTIX_PROJECT_ID: PROJECT },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const text = stdout.trim() || stderr.trim();
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
      if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return Response.json({ error: 'unauthorized' }, { status: 401 });
      const { pathname } = new URL(req.url);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      calls.push({ path: pathname, body });
      return Response.json({ ok: true, conversationId: body.conversation_id, messageId: body.message_id });
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

describe('teams edit / delete', () => {
  test('edit replaces the message by the id `post` returned, with new text', async () => {
    const { exitCode, body } = await runTeams(['edit', '--conversation', CONVERSATION, '--message', 'act-1', 'Fixed the numbers']);
    expect(exitCode).toBe(0);
    expect(body).toMatchObject({ ok: true, messageId: 'act-1' });
    expect(calls).toEqual([{
      path: `/v1/projects/${PROJECT}/channels/teams/message/edit`,
      body: { conversation_id: CONVERSATION, message_id: 'act-1', text: 'Fixed the numbers' },
    }]);
  }, SPAWN_TIMEOUT_MS);

  test('edit takes a card file instead of text', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'teams-edit-'));
    const file = resolve(dir, 'card.json');
    writeFileSync(file, JSON.stringify({ type: 'AdaptiveCard', version: '1.5', body: [] }));
    const { exitCode } = await runTeams(['edit', '--conversation', CONVERSATION, '--message', 'act-1', '--card-file', file]);
    expect(exitCode).toBe(0);
    expect(calls[0]!.body.card).toEqual({ type: 'AdaptiveCard', version: '1.5', body: [] });
  }, SPAWN_TIMEOUT_MS);

  test('delete removes the message', async () => {
    const { exitCode } = await runTeams(['delete', '--conversation', CONVERSATION, '--message', 'act-1']);
    expect(exitCode).toBe(0);
    expect(calls).toEqual([{
      path: `/v1/projects/${PROJECT}/channels/teams/message/delete`,
      body: { conversation_id: CONVERSATION, message_id: 'act-1' },
    }]);
  }, SPAWN_TIMEOUT_MS);

  test('without a message id, or with nothing to say, nothing is sent', async () => {
    expect((await runTeams(['delete', '--conversation', CONVERSATION])).exitCode).not.toBe(0);
    expect((await runTeams(['edit', '--conversation', CONVERSATION, '--message', 'act-1'])).exitCode).not.toBe(0);
    expect(calls).toEqual([]);
  }, SPAWN_TIMEOUT_MS);
});
