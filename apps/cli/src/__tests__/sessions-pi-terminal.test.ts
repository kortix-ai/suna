import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const project = '00000000-0000-4000-a000-000000000111';
const session = '00000000-0000-4000-a000-000000000222';
const native = 'ses_pi_terminal';
const api = `/v1/projects/${project}/sessions/${session}`;
const runtime = '/v1/p/pi-terminal-worker/8000';
const entry = resolve(import.meta.dir, '../index.ts');
let directory: string;
let server: ReturnType<typeof Bun.serve>;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output: string;
let errors: string;
let isPi: boolean;
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
let seen: Array<{ method: string; path: string; body: any; auth: string | null }>;
let questions: any[];
let permissions: any[];
let failReply: boolean;
let stallHistory: boolean;

async function until(check: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`Condition timed out\n${output}\n${errors}`);
    await Bun.sleep(10);
  }
}

function emit(type: string, properties: Record<string, unknown>) {
  stream!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
}

async function start(args: string[] = []) {
  child = Bun.spawn(
    [process.execPath, entry, 'sessions', 'connect', session, '--project', project, ...args],
    {
      cwd: directory,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        KORTIX_CONFIG_FILE: join(directory, 'config.json'),
        KORTIX_AUTH_FILE: join(directory, 'config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
        KORTIX_TOKEN: '',
        KORTIX_API_URL: '',
        KORTIX_PROJECT_ID: '',
        KORTIX_OPENCODE_BIN: join(directory, 'opencode'),
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    },
  );
  const consume = async (input: ReadableStream, append: (value: string) => void) => {
    for await (const part of input) append(new TextDecoder().decode(part));
  };
  void consume(child.stdout as ReadableStream, (text) => {
    output += text;
  });
  void consume(child.stderr as ReadableStream, (text) => {
    errors += text;
  });
}

function line(value: string) {
  (child!.stdin as import('bun').FileSink).write(value + '\n');
  (child!.stdin as import('bun').FileSink).flush();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kortix-pi-terminal-'));
  output = '';
  errors = '';
  seen = [];
  isPi = true;
  questions = [];
  permissions = [];
  failReply = false;
  stallHistory = false;
  stream = undefined;
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json().catch(() => null) : null;
      seen.push({ method: request.method, path, body, auth: request.headers.get('authorization') });
      if (stallHistory && path === runtime + `/session/${native}/message`)
        return new Promise<Response>(() => {});
      if (failReply && path.endsWith('/question/retry-question/reply')) {
        failReply = false;
        return Response.json({ message: 'Synthetic persistence failure' }, { status: 503 });
      }
      if (path === api)
        return Response.json({
          session_id: session,
          project_id: project,
          status: 'running',
          name: 'Pi terminal',
          agent_name: 'reader',
          metadata: {
            ...(isPi ? { pi_worker_boot: true } : {}),
            opencode_model: 'kortix/test-model',
          },
        });
      if (path === api + '/start')
        return Response.json({
          stage: 'ready',
          agent_name: 'reader',
          sandbox: { external_id: 'pi-terminal-worker' },
          opencode_session_id: native,
        });
      if (path === api + '/prompts' && request.method === 'POST')
        return Response.json(
          {
            prompt_id: 'prompt-1',
            state: 'queued',
            message_id: body.message_id,
            deduped: false,
          },
          { status: 201 },
        );
      if (path === runtime + '/global/health')
        return Response.json({ healthy: true, version: '1.18.23' });
      if (path === runtime + '/event' || path === runtime + '/global/event')
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              emit('server.connected', {});
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      if (path === runtime + `/session/${native}/message`) return Response.json([]);
      if (path === runtime + '/question') return Response.json(questions);
      if (path === runtime + '/permission') return Response.json(permissions);
      if (path === runtime + `/session/${native}/abort`) return Response.json(true);
      if (/\/(question|permission)\/[^/]+\/(reply|reject)$/.test(path)) return Response.json(true);
      return Response.json({ error: 'Unexpected route ' + path }, { status: 404 });
    },
  });
  writeFileSync(
    join(directory, 'config.json'),
    JSON.stringify({
      active: 'test',
      hosts: {
        test: {
          url: `http://127.0.0.1:${server.port}`,
          token: 'kortix_pat_terminal_fixture',
          account_id: 'account-test',
        },
      },
    }),
  );
  writeFileSync(join(directory, 'opencode'), '#!/bin/sh\nprintf OPENCODE_STARTED\nexit 23\n', {
    mode: 0o700,
  });
});

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await child.exited;
  }
  child = undefined;
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

test('Pi connects without OpenCode and EOF detaches without aborting', async () => {
  await start();
  await until(() => output.includes('Connected to Pi'));
  (child!.stdin as import('bun').FileSink).end();
  await until(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(0);
  expect(output).not.toContain('OPENCODE_STARTED');
  expect(
    seen.some((call) => call.path.endsWith('/global/health') || call.path.endsWith('/abort')),
  ).toBe(false);
});

test('OpenCode sessions keep the OpenCode TUI', async () => {
  isPi = false;
  await start();
  await until(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(23);
  expect(output).toContain('OPENCODE_STARTED');
});

test.each([
  ['--port', '4100'],
  ['--', '--mini'],
])('Pi rejects OpenCode-only arguments %j', async (...args) => {
  await start(args as string[]);
  await until(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(2);
  expect(errors).toContain('only supported for OpenCode sessions');
  expect(output).not.toContain('OPENCODE_STARTED');
});

test('Pi streams text, answers multiple questions, approves permissions and stops through the SDK', async () => {
  await start();
  await until(() => output.includes('Connected to Pi') && Boolean(stream));
  line('terminal prompt');
  await until(() => seen.some((call) => call.path === api + '/prompts'));
  const prompt = seen.find((call) => call.path === api + '/prompts')!;
  expect(prompt.body).toMatchObject({
    parts: [{ type: 'text', text: 'terminal prompt' }],
    remint_on_delivery: true,
  });
  emit('message.updated', { info: { id: 'assistant-1', role: 'assistant', sessionID: native } });
  emit('message.part.updated', {
    part: { id: 'part-1', type: 'text', text: '', messageID: 'assistant-1', sessionID: native },
  });
  emit('message.part.delta', {
    partID: 'part-1',
    messageID: 'assistant-1',
    sessionID: native,
    field: 'text',
    delta: 'FIRST_FRAGMENT',
  });
  await until(() => output.includes('FIRST_FRAGMENT'));
  expect(output).not.toContain('SECOND_FRAGMENT');
  emit('message.part.updated', {
    part: {
      id: 'part-1',
      type: 'text',
      text: 'FIRST_FRAGMENT SECOND_FRAGMENT',
      messageID: 'assistant-1',
      sessionID: native,
    },
  });
  emit('question.asked', {
    id: 'question-1',
    sessionID: native,
    questions: [
      {
        header: 'Shape',
        question: 'Pick a shape',
        options: [
          { label: 'Circle', description: 'Round' },
          { label: 'Triangle', description: 'Three sides' },
        ],
        custom: false,
      },
      {
        header: 'Colors',
        question: 'Pick colors',
        options: [
          { label: 'Purple', description: '' },
          { label: 'Yellow', description: '' },
        ],
        multiple: true,
        custom: false,
      },
    ],
  });
  await until(() => output.includes('Pick a shape'));
  line('9');
  await until(() => output.includes('Choose a listed option'));
  expect(seen.some((call) => call.path.endsWith('/question/question-1/reply'))).toBe(false);
  line('2');
  await until(() => output.includes('Pick colors'));
  line('1,2');
  await until(() => seen.some((call) => call.path.endsWith('/question/question-1/reply')));
  expect(seen.find((call) => call.path.endsWith('/question/question-1/reply'))!.body).toEqual({
    answers: [['Triangle'], ['Purple', 'Yellow']],
  });
  emit('permission.asked', {
    id: 'permission-1',
    sessionID: native,
    permission: 'bash',
    patterns: ['echo SAFE'],
    metadata: { command: 'echo SAFE', reason: 'permission detail fixture' },
    always: [],
  });
  await until(() => output.includes('echo SAFE'));
  expect(output).toContain('permission detail fixture');
  line('always');
  await until(() => seen.some((call) => call.path.endsWith('/permission/permission-1/reply')));
  expect(
    seen.find((call) => call.path.endsWith('/permission/permission-1/reply'))!.body,
  ).toMatchObject({ reply: 'always' });
  line('/stop');
  await until(() => seen.some((call) => call.path.endsWith('/abort')));
  line('/exit');
  await until(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(0);
  expect(output.split('FIRST_FRAGMENT').length - 1).toBe(1);
  expect(output).toContain('SECOND_FRAGMENT');
  expect(seen.every((call) => call.auth === 'Bearer kortix_pat_terminal_fixture')).toBe(true);
});

test('Pi restores pending questions and dismisses them without creating a new prompt', async () => {
  questions = [
    {
      id: 'restored',
      sessionID: native,
      questions: [{ header: 'Restored', question: 'Restored question', options: [] }],
    },
  ];
  await start();
  await until(() => output.includes('Restored question'));
  line('/reject');
  await until(() => seen.some((call) => call.path.endsWith('/question/restored/reject')));
  line('/exit');
  await until(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(0);
  expect(seen.some((call) => call.path === api + '/prompts')).toBe(false);
});

test('a failed question reply keeps prior answers for retry, including numeric free text', async () => {
  questions = [
    {
      id: 'retry-question',
      sessionID: native,
      questions: [
        { header: 'Label', question: 'Type a label', options: [] },
        { header: 'Count', question: 'Type a count', options: [{ label: 'One', description: 'One item' }] },
      ],
    },
  ];
  failReply = true;
  await start();
  await until(() => output.includes('Type a label'));
  line('retained');
  await until(() => output.includes('Type a count'));
  line('123');
  await until(() => errors.includes('Synthetic persistence failure'));
  line('456');
  await until(
    () => seen.filter((call) => call.path.endsWith('/question/retry-question/reply')).length === 2,
  );
  const replies = seen.filter((call) => call.path.endsWith('/question/retry-question/reply'));
  expect(replies.map((call) => call.body.answers)).toEqual([
    [['retained'], ['123']],
    [['retained'], ['456']],
  ]);
  line('/exit');
  await until(() => child!.exitCode !== null);
  expect(child!.exitCode).toBe(0);
});

test('foreign-session events remain invisible and SIGINT stops without ending the terminal', async () => {
  await start();
  await until(() => Boolean(stream));
  emit('question.asked', {
    id: 'foreign',
    sessionID: 'ses_other',
    questions: [{ header: 'Secret', question: 'FOREIGN_SECRET', options: [] }],
  });
  emit('message.updated', {
    info: { id: 'foreign-message', role: 'assistant', sessionID: 'ses_other' },
  });
  emit('message.part.updated', {
    part: {
      id: 'foreign-part',
      messageID: 'foreign-message',
      sessionID: 'ses_other',
      type: 'text',
      text: 'FOREIGN_SECRET',
    },
  });
  child!.kill('SIGINT');
  await until(() => seen.some((call) => call.path.endsWith('/abort')));
  line('next prompt');
  await until(() => seen.some((call) => call.path === api + '/prompts'));
  expect(output).not.toContain('FOREIGN_SECRET');
  expect(child!.exitCode).toBe(null);
  line('/exit');
  await until(() => child!.exitCode !== null);
});

test('a stalled history read ends with a timeout instead of hanging the terminal', async () => {
  stallHistory = true;
  await start();
  await until(() => child!.exitCode !== null, 27000);
  expect(child!.exitCode).toBe(1);
  expect(errors).toContain('operation timed out');
  expect(seen.some((call) => call.path.endsWith('/abort'))).toBe(false);
}, 30000);
