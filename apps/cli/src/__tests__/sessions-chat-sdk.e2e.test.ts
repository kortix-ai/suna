import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kortixFromAuth, withKortixScope } from '../api/sdk.ts';
import { runSessions } from '../commands/sessions.ts';

const PROJECT_ID = '00000000-0000-4000-a000-00000000c111';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c222';
const SESSION_ID = '00000000-0000-4000-a000-00000000c333';
const ROOT_THREAD_ID = 'ses_cli_sdk';
const EXTERNAL_ID = 'external-cli-sdk';
const TOKEN = 'kortix_pat_cli_sdk';

const ENV_KEYS = [
  'KORTIX_CONFIG_FILE',
  'KORTIX_TOKEN',
  'KORTIX_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

const savedEnv: Record<string, string | undefined> = {};
const realStdoutWrite = process.stdout.write;
const realStderrWrite = process.stderr.write;

let directory = '';
let server: ReturnType<typeof Bun.serve> | null = null;
let stdout = '';
let stderr = '';
let promptBody: Record<string, unknown> | null = null;
let runtimeAuthorization: string | null = null;
let runtimePromptPosts = 0;
let createBody: Record<string, unknown> | null = null;
/** The box's session log: a reply appears once a prompt reaches the inbox. */
let transcript: unknown[] = [];
/** When true, the assistant reply stops with a structured runtime error. */
let replyError = false;
let provisioning = false;
let startPosts = 0;
let stopped = false;
/** The initial prompt's turn: its messages so far, and how many more pending reads see the root busy. */
let initialTurn: unknown[] | null = null;
let busyReads = 0;

function sessionRow() {
  return {
    session_id: SESSION_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    branch_name: SESSION_ID,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: provisioning ? null : SESSION_ID,
    sandbox_url: null,
    opencode_session_id: provisioning ? null : ROOT_THREAD_ID,
    name: 'SDK chat',
    custom_name: null,
    agent_name: 'default',
    status: stopped ? 'stopped' : provisioning ? 'provisioning' : 'running',
    error: null,
    metadata: {},
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
  };
}

const PRODUCER = { harness: 'pi', harness_version: '1', adapter_version: '1' };

function record(message_id: string, seq: number, over: Record<string, unknown>) {
  return {
    schema: 'kortix.session/2', v: 1, message_id, thread_id: ROOT_THREAD_ID, seq, kind: 'turn', status: 'complete',
    in_context: true, model: null, usage: null, finish: null, error: null, created_at: '2026-07-30T00:00:01.000Z',
    completed_at: null, producer: PRODUCER, blocks: [], ...over,
  };
}

function userMessage(id: string, text: string) {
  return record(id, transcript.length + 1, { role: 'user', blocks: [{ type: 'text', id: `${id}-b0`, text }] });
}

function assistantReply(replyTo = 'msg_user') {
  return record(`${replyTo}-reply`, transcript.length + 2, {
    role: 'assistant',
    reply_to: replyTo,
    finish: replyError ? 'error' : 'stop',
    completed_at: '2026-07-30T00:00:03.000Z',
    blocks: [{ type: 'text', id: `${replyTo}-reply-b0`, text: 'Runtime reply' }],
    ...(replyError ? { status: 'error', error: { code: 'APIError', message: 'Synthetic model requires a paid plan.' } } : {}),
  });
}

describe('sessions chat uses the session-scoped SDK runtime', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';

    directory = mkdtempSync(join(tmpdir(), 'kortix-cli-sdk-chat-'));
    stdout = '';
    stderr = '';
    promptBody = null;
    runtimeAuthorization = null;
    runtimePromptPosts = 0;
    createBody = null;
    transcript = [];
    replyError = false;
    provisioning = false;
    startPosts = 0;
    stopped = false;
    initialTurn = null;
    busyReads = 0;

    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === `/v1/projects/${PROJECT_ID}/sessions`) {
          createBody = (await request.json()) as Record<string, unknown>;
          return Response.json(sessionRow());
        }
        if (
          request.method === 'GET' &&
          url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`
        ) {
          return Response.json(sessionRow());
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/start`
        ) {
          startPosts += 1;
          provisioning = false;
          return Response.json({
            stage: 'ready',
            agent_name: 'default',
            retriable: false,
            sandbox: { external_id: EXTERNAL_ID },
            opencode_session_id: ROOT_THREAD_ID,
          });
        }
        if (
          request.method === 'POST' &&
          url.pathname === `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/prompts`
        ) {
          // The inbox holds the prompt; the runtime answers it.
          runtimePromptPosts += 1;
          promptBody = (await request.json()) as Record<string, unknown>;
          const id = String(promptBody.message_id);
          const text = (promptBody.parts as Array<{ text: string }>)[0]!.text;
          transcript.push(userMessage(id, text), assistantReply(id));
          return Response.json({ prompt_id: 'prompt_1', state: 'pending', message_id: id, deduped: false });
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${EXTERNAL_ID}/8000/kortix/health`) {
          return Response.json({ capabilities: ['session.subagents', 'session.compact', 'runtime.actions.v1'] });
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${EXTERNAL_ID}/8000/kortix/runtime/log`) {
          runtimeAuthorization = request.headers.get('authorization');
          // `chat --new` reads the reply to its initial prompt, which session
          // creation queued.
          const messages = transcript.length ? transcript : (initialTurn ?? [userMessage('msg_user', 'one initial prompt'), assistantReply()]);
          return Response.json({ thread_id: ROOT_THREAD_ID, messages, has_more: false });
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${EXTERNAL_ID}/8000/kortix/runtime/pending`) {
          if (busyReads > 0) {
            busyReads -= 1;
            // The turn ends with this read: its last step lands.
            if (busyReads === 0 && initialTurn) initialTurn.push(record('msg_user-final', 4, { role: 'assistant', reply_to: 'msg_user', blocks: [{ type: 'text', id: 'final-b0', text: 'Final answer' }] }));
            return Response.json({ statuses: { [ROOT_THREAD_ID]: 'busy' }, permissions: [], questions: [] });
          }
          return Response.json({ statuses: {}, permissions: [], questions: [] });
        }
        return Response.json(
          { error: `unexpected ${request.method} ${url.pathname}` },
          { status: 404 },
        );
      },
    });

    const configPath = join(directory, 'config.json');
    process.env.KORTIX_CONFIG_FILE = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        active: 'default',
        hosts: {
          default: {
            url: `http://127.0.0.1:${server.port}`,
            token: TOKEN,
            user_id: 'user-cli-sdk',
            user_email: 'cli-sdk@example.test',
            account_id: ACCOUNT_ID,
            logged_in_at: '2026-07-30T00:00:00.000Z',
          },
        },
      }),
    );

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    if (server) {
      // The SDK keeps the session's runtime per session id: drop it with the server it points at.
      const auth = {
        api_base: `http://127.0.0.1:${server.port}`,
        token: TOKEN,
        user_id: 'user-cli-sdk',
        user_email: 'cli-sdk@example.test',
        account_id: ACCOUNT_ID,
        logged_in_at: '2026-07-30T00:00:00.000Z',
      };
      await withKortixScope(auth, () => kortixFromAuth(auth).session(PROJECT_ID, SESSION_ID).stop()).catch(() => {});
    }
    server?.stop(true);
    server = null;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test('chat rejects stopped sessions, starts unused sessions, and reads the prompt reply', async () => {
    stopped = true;
    const stoppedCode = await runSessions([
      'chat', SESSION_ID, '--project', PROJECT_ID, '--prompt', 'Reply pong', '--json',
    ]);
    expect(stoppedCode).toBe(1);
    expect(stderr).toContain('not running');
    expect(startPosts).toBe(0);
    expect(runtimePromptPosts).toBe(0);
    stopped = false;
    stderr = '';
    provisioning = true;
    const chatCode = await runSessions([
      'chat',
      SESSION_ID,
      '--project',
      PROJECT_ID,
      '--prompt',
      'hello from the CLI',
      '--json',
    ]);

    expect(chatCode).toBe(0);
    expect(startPosts).toBeGreaterThan(0);
    expect(runtimeAuthorization).toBe(`Bearer ${TOKEN}`);
    expect(promptBody).toMatchObject({
      parts: [{ type: 'text', text: 'hello from the CLI' }],
      overrides: { agent: 'default' },
      remint_on_delivery: true,
    });
    expect(JSON.parse(stdout).text).toBe('Runtime reply');

    stdout = '';
    const logCode = await runSessions([
      'log',
      SESSION_ID,
      '--project',
      PROJECT_ID,
      '--limit',
      '5',
      '--json',
    ]);

    expect(logCode).toBe(0);
    expect(runtimeAuthorization).toBe(`Bearer ${TOKEN}`);
    // No stored session log (this API answers GET …/log with 404): the box's own log.
    const log = JSON.parse(stdout) as {
      schema: string;
      source: string;
      threads: Array<{ thread_id: string; messages: Array<{ role: string; blocks: Array<{ type: string; text?: string }> }> }>;
    };
    expect(log).toMatchObject({ schema: 'kortix.session/2', source: 'log' });
    expect(log.threads.map((t) => t.thread_id)).toEqual([ROOT_THREAD_ID]);
    expect(log.threads[0]!.messages.map((m) => [m.role, m.blocks.find((b) => b.type === 'text')?.text])).toEqual([
      ['user', 'hello from the CLI'],
      ['assistant', 'Runtime reply'],
    ]);

    // The OpenCode-shaped v1 rows are gone.
    stdout = '';
    expect(await runSessions(['log', SESSION_ID, '--project', PROJECT_ID, '--limit', '5', '--json', '--schema', 'v1'])).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('Invalid --schema "v1"');
    stderr = '';

    stdout = '';
    const code = await runSessions([
      'chat',
      '--new',
      '--project',
      PROJECT_ID,
      '--prompt',
      'one initial prompt',
      '--agent',
      'default',
      '--json',
    ]);

    expect(code).toBe(0);
    expect(createBody).toMatchObject({ initial_prompt: 'one initial prompt', agent_name: 'default' });
    // `--new` sends its prompt as the session's initial prompt, not a second one.
    expect(runtimePromptPosts).toBe(1);
    expect(JSON.parse(stdout).text).toBe('Runtime reply');
    expect(stderr).toBe('');

    // A turn that stops with a structured runtime error surfaces its name and
    // message in chat and log output, and keeps the error record in --json.
    replyError = true;
    stdout = '';
    const failedCode = await runSessions([
      'chat',
      SESSION_ID,
      '--project',
      PROJECT_ID,
      '--prompt',
      'synthetic failure',
    ]);
    expect(failedCode).toBe(1);
    expect(stdout).toContain('error: APIError: Synthetic model requires a paid plan.');
    expect(stdout).not.toContain('error: unknown');

    stdout = '';
    expect(
      await runSessions(['log', SESSION_ID, '--project', PROJECT_ID, '--limit', '5']),
    ).toBe(0);
    expect(stdout).toContain('error: APIError: Synthetic model requires a paid plan.');

    stdout = '';
    expect(await runSessions(['log', SESSION_ID, '--project', PROJECT_ID, '--json'])).toBe(0);
    const logged = JSON.parse(stdout) as { threads: Array<{ messages: Array<{ role: string; error?: unknown }> }> };
    expect(logged.threads[0]!.messages.at(-1)).toMatchObject({
      role: 'assistant',
      status: 'error',
      error: { code: 'APIError', message: 'Synthetic model requires a paid plan.' },
    });

  });
  test('chat --new prints the reply that ends the first turn, not a step the turn has not finished', async () => {
    // A finished tool step while the root is still busy, then the final answer.
    initialTurn = [
      userMessage('msg_user', 'one initial prompt'),
      record('msg_user-step', 3, { role: 'assistant', reply_to: 'msg_user', blocks: [{ type: 'tool_call', id: 'step-b0', call_id: 'c1', name: 'question', kind: 'question', input: {}, status: 'complete', result: { content: [{ type: 'text', text: 'Pear' }], is_error: false } }] }),
    ];
    busyReads = 2;
    const code = await runSessions(['chat', '--new', '--project', PROJECT_ID, '--prompt', 'one initial prompt', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).text).toBe('Final answer');
    expect(busyReads).toBe(0);
  });
});
