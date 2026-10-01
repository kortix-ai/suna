import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSessions } from '../commands/sessions.ts';

const PROJECT_ID = '00000000-0000-4000-a000-00000000c111';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c222';
const SESSION_ID = '00000000-0000-4000-a000-00000000c333';
const OPENCODE_SESSION_ID = 'ses_cli_sdk';
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
/** The runtime's transcript: a reply appears once a prompt reaches the inbox. */
let transcript: unknown[] = [];

function sessionRow() {
  return {
    session_id: SESSION_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    branch_name: SESSION_ID,
    base_ref: 'main',
    sandbox_provider: 'daytona',
    sandbox_id: SESSION_ID,
    sandbox_url: null,
    opencode_session_id: OPENCODE_SESSION_ID,
    name: 'SDK chat',
    custom_name: null,
    agent_name: 'default',
    status: 'running',
    error: null,
    metadata: {},
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
  };
}

function userMessage(id: string, text: string) {
  return {
    info: {
      id,
      role: 'user',
      sessionID: OPENCODE_SESSION_ID,
      agent: 'default',
      model: { providerID: 'test-provider', modelID: 'test-model' },
      time: { created: 1 },
    },
    parts: [{ id: `${id}-p0`, sessionID: OPENCODE_SESSION_ID, messageID: id, type: 'text', text }],
  };
}

function assistantReply(parentID = 'msg_user') {
  return {
    info: {
      id: `${parentID}-reply`,
      role: 'assistant',
      sessionID: OPENCODE_SESSION_ID,
      parentID,
      agent: 'default',
      mode: 'build',
      modelID: 'test-model',
      providerID: 'test-provider',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 2, completed: 3 },
      finish: 'stop',
    },
    parts: [
      {
        id: 'part_assistant',
        sessionID: OPENCODE_SESSION_ID,
        messageID: `${parentID}-reply`,
        type: 'text',
        text: 'OpenCode REST reply',
      },
    ],
  };
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
          return Response.json({
            stage: 'ready',
            agent_name: 'default',
            retriable: false,
            sandbox: { external_id: EXTERNAL_ID },
            opencode_session_id: OPENCODE_SESSION_ID,
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
        if (
          request.method === 'GET' &&
          url.pathname === `/v1/p/${EXTERNAL_ID}/8000/kortix/runtime/messages/${OPENCODE_SESSION_ID}`
        ) {
          runtimeAuthorization = request.headers.get('authorization');
          // `chat --new` reads the reply to its initial prompt, which session
          // creation queued.
          const messages = transcript.length ? transcript : [userMessage('msg_user', 'one initial prompt'), assistantReply()];
          return Response.json({ messages, has_more: false });
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${EXTERNAL_ID}/8000/session/status`) {
          return Response.json({});
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${EXTERNAL_ID}/8000/permission`) {
          return Response.json([]);
        }
        if (request.method === 'GET' && url.pathname === `/v1/p/${EXTERNAL_ID}/8000/question`) {
          return Response.json([]);
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

  afterEach(() => {
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
    server?.stop(true);
    server = null;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test('sends through the prompt inbox and reads the reply from the session runtime', async () => {
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
    expect(runtimeAuthorization).toBe(`Bearer ${TOKEN}`);
    expect(promptBody).toMatchObject({
      parts: [{ type: 'text', text: 'hello from the CLI' }],
      overrides: { agent: 'default' },
      remint_on_delivery: true,
    });
    expect(JSON.parse(stdout).text).toBe('OpenCode REST reply');

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
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({ role: 'user', text: 'hello from the CLI' }),
      expect.objectContaining({ role: 'assistant', text: 'OpenCode REST reply' }),
    ]);

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
    expect(JSON.parse(stdout).text).toBe('OpenCode REST reply');
    expect(stderr).toBe('');
  });
});
