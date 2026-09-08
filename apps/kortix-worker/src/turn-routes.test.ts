import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request as nodeRequest } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, UserMessage } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import type { SessionLogItem } from './session-store.ts';
import { mintWireMessageId, wireIdTime } from './wire-message-id.ts';
import { DEFAULT_TURN_OWNER_LEASE_MS, startWorker, tapFirstToken } from './worker.ts';

const workers: Array<Awaited<ReturnType<typeof startWorker>>> = [];
const supportServers: Array<ReturnType<typeof createServer>> = [];
const eventControllers: AbortController[] = [];

afterEach(async () => {
  for (const controller of eventControllers.splice(0)) controller.abort();
  await Promise.all(
    workers.splice(0).map((worker) => {
      worker.server.closeAllConnections();
      return worker.close();
    }),
  );
  await Promise.all(
    supportServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  return value;
}

function agentMessageRecord(message: unknown): {
  role?: unknown;
  content?: unknown;
  kortixWireMessageId?: unknown;
} {
  return message && typeof message === 'object' ? message : {};
}

function agentMessageHasText(message: unknown, text: string): boolean {
  const candidate = agentMessageRecord(message);
  if (candidate.role !== 'user' || !Array.isArray(candidate.content)) return false;
  return candidate.content.some(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      'text' in part &&
      (part as { text?: unknown }).text === text,
  );
}

function agentMessageText(message: unknown): string {
  const content = agentMessageRecord(message).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part !== null && typeof part === 'object' && 'text' in part
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  supportServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function sharedStore(
  items: SessionLogItem[],
  rejectAppend?: (item: SessionLogItem) => number | undefined,
): Promise<string> {
  const byKey = new Map<string, SessionLogItem>();
  return listen(
    createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const item = JSON.parse(body) as SessionLogItem;
      const rejected = rejectAppend?.(item);
      if (rejected) {
        res.writeHead(rejected).end();
        return;
      }
      const key = String(req.headers['idempotency-key'] ?? '');
      const existing = key ? byKey.get(key) : undefined;
      if (existing) {
        if (!isDeepStrictEqual(existing, item)) {
          res
            .writeHead(409, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'idempotency key reused with different item' }));
          return;
        }
        res.writeHead(204).end();
        return;
      }
      const clone = structuredClone(item);
      if (key) byKey.set(key, clone);
      items.push(clone);
      res.writeHead(204).end();
    }),
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(5);
  }
}

async function start() {
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Answer exactly.',
    modelMode: 'faux',
    sessionId: `turn-routes-${workers.length}`,
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  return worker;
}

function request(
  worker: Awaited<ReturnType<typeof startWorker>>,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set('authorization', 'Bearer runtime-token');
  return fetch(`http://127.0.0.1:${worker.port}${path}`, { ...init, headers });
}

async function waitForGlobalEvent(
  worker: Awaited<ReturnType<typeof startWorker>>,
  type: string,
  messageId: string,
  timeoutMs = 2_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body = '';
  try {
    const response = await request(worker, '/global/event', { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = requireValue(response.body, 'global event body').getReader();
    while (!body.includes(`\"type\":\"${type}\"`) || !body.includes(messageId)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += new TextDecoder().decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (!body.includes(`\"type\":\"${type}\"`) || !body.includes(messageId)) {
    throw new Error(`did not observe ${type} for ${messageId}`);
  }
  return body;
}

async function waitForGlobalEventContaining(
  worker: Awaited<ReturnType<typeof startWorker>>,
  fragments: readonly string[],
  timeoutMs = 2_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body = '';
  try {
    const response = await request(worker, '/global/event', { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = requireValue(response.body, 'global event body').getReader();
    while (!fragments.every((fragment) => body.includes(fragment))) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += new TextDecoder().decode(chunk.value, { stream: true });
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (!fragments.every((fragment) => body.includes(fragment))) {
    throw new Error(`did not observe event fragments: ${fragments.join(', ')}`);
  }
  return body;
}

function chunkedRequest(
  worker: Awaited<ReturnType<typeof startWorker>>,
  path: string,
  chunks: readonly Uint8Array[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(
      {
        hostname: '127.0.0.1',
        port: worker.port,
        path,
        method: 'POST',
        headers: {
          authorization: 'Bearer runtime-token',
          'content-type': 'application/json',
        },
      },
      (res) => {
        const body: Buffer[] = [];
        res.on('data', (chunk) => body.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(body).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

function openEndedOversizedRequest(
  worker: Awaited<ReturnType<typeof startWorker>>,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('oversized request did not settle')), 500);
    const req = nodeRequest(
      {
        hostname: '127.0.0.1',
        port: worker.port,
        path,
        method: 'POST',
        headers: {
          authorization: 'Bearer runtime-token',
          'content-type': 'application/json',
          'content-length': 1024 * 1024,
        },
      },
      (res) => {
        const body: Buffer[] = [];
        res.on('data', (chunk) => body.push(Buffer.from(chunk)));
        res.on('end', () => {
          clearTimeout(timer);
          req.destroy();
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(body).toString('utf8'),
          });
        });
      },
    );
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.write('{');
  });
}

function expectV2AssistantInfo(info: AssistantMessage): void {
  expect(info.id).toMatch(/^msg_/);
  expect(info.sessionID).toMatch(/^ses_pi/);
  expect(info.parentID).toMatch(/^msg_/);
  expect(info.modelID).toEqual(expect.any(String));
  expect(info.providerID).toEqual(expect.any(String));
  expect(info.agent).toBe('build');
  expect(info.mode).toBe('build');
  expect(info.path).toEqual({ cwd: '/workspace', root: '/workspace' });
  expect(info.cost).toBe(0);
  expect(info.tokens).toEqual({
    input: expect.any(Number),
    output: expect.any(Number),
    reasoning: expect.any(Number),
    cache: { read: expect.any(Number), write: expect.any(Number) },
  });
  expect(Object.keys(info.tokens).sort()).toEqual(['cache', 'input', 'output', 'reasoning']);
}

async function rootId(worker: Awaited<ReturnType<typeof startWorker>>): Promise<string> {
  const sessions = (await (await request(worker, '/session')).json()) as Array<{ id: string }>;
  return requireValue(sessions[0], 'root session').id;
}

async function prime(worker: Awaited<ReturnType<typeof startWorker>>, replies: string[]) {
  requireValue(worker.faux, 'faux model').setResponses(
    replies.map((text) => fauxAssistantMessage(text)),
  );
}

async function watchGlobalEvents(worker: Awaited<ReturnType<typeof startWorker>>) {
  const controller = new AbortController();
  eventControllers.push(controller);
  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${worker.port}`,
    fetch: (async (input, init) => {
      const req = new Request(input, init);
      req.headers.set('authorization', 'Bearer runtime-token');
      return fetch(req);
    }) as typeof fetch,
  });
  const { stream } = await client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 1 });
  const events: Array<{ type: string }> = [];
  const errors: unknown[] = [];
  void (async () => {
    try {
      for await (const envelope of stream) events.push(envelope.payload);
    } catch (error) {
      if (!controller.signal.aborted) errors.push(error);
    }
  })();
  await waitUntil(() => events.some((event) => event.type === 'server.connected'));
  return { events, errors };
}

describe('raw OpenCode turn routes', () => {
  test('serves empty command, permission, question, and idle-status collections', async () => {
    const worker = await start();

    for (const [path, expected] of [
      ['/command', []],
      ['/permission', []],
      ['/question', []],
      ['/session/status', {}],
    ] as const) {
      const response = await request(worker, path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
  });

  test('runs the question tool through list, SSE, reply, and resumed model output', async () => {
    const worker = await start();
    requireValue(worker.faux, 'faux model').setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('question', {
            questions: [
              {
                question: 'Which database should this project use?',
                header: 'Database',
                options: [
                  { label: 'PostgreSQL', description: 'Use the existing service.' },
                  { label: 'SQLite', description: 'Use one local file.' },
                ],
              },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('Using PostgreSQL.'),
    ]);
    const sessionID = await rootId(worker);
    const askedEvent = waitForGlobalEventContaining(worker, ['question.asked', 'Database']);

    const prompt = await request(worker, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: mintWireMessageId({ nowMs: Date.now() + 1_000 }).id,
        parts: [{ type: 'text', text: 'Pick a database.' }],
      }),
    });
    expect(prompt.status).toBe(204);
    await askedEvent;

    let pending: Array<{ id: string; sessionID: string; questions: unknown[] }> = [];
    await waitUntil(async () => {
      pending = (await (await request(worker, '/question')).json()) as typeof pending;
      return pending.length === 1;
    });
    expect(pending[0]).toMatchObject({ sessionID, questions: [{ header: 'Database' }] });

    const pendingQuestion = requireValue(pending[0], 'pending question');
    const repliedEvent = waitForGlobalEventContaining(worker, [
      'question.replied',
      pendingQuestion.id,
      'PostgreSQL',
    ]);
    const reply = await request(worker, `/question/${pendingQuestion.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [['PostgreSQL']] }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toBe(true);
    await repliedEvent;

    let transcript: Array<{ parts: Array<{ text?: string }> }> = [];
    await waitUntil(async () => {
      transcript = (await (
        await request(worker, `/session/${sessionID}/message?limit=20`)
      ).json()) as typeof transcript;
      return transcript.some((message) =>
        message.parts.some((part) => part.text === 'Using PostgreSQL.'),
      );
    });
    expect(await (await request(worker, '/question')).json()).toEqual([]);
  });

  test('runs a compiled permission ask through list, SSE, reply, execution, and completion', async () => {
    const rpcCalls: Array<{ op: string; args?: { command?: string } }> = [];
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string; args?: { command?: string } };
        rpcCalls.push(rpc);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ ok: true, value: { stdout: 'allowed\n', stderr: '', exitCode: 0 } }),
          );
      }),
    );
    const globals = globalThis as Record<string, unknown>;
    const previousCompiled = globals.__KORTIX_COMPILED__;
    globals.__KORTIX_COMPILED__ = {
      manifest: { default_agent: 'build' },
      agentConfig: { agent: { build: { permission: { bash: 'ask' } } } },
    };
    let worker: Awaited<ReturnType<typeof startWorker>>;
    try {
      worker = await startWorker({
        port: 0,
        envUrl,
        envUrlExplicit: true,
        envCwd: '/workspace',
        envTransport: 'fetch',
        systemPrompt: 'Answer exactly.',
        modelMode: 'faux',
        sessionId: 'permission-route',
        kortixToken: 'runtime-token',
      });
    } finally {
      globals.__KORTIX_COMPILED__ = previousCompiled;
    }
    workers.push(worker);
    requireValue(worker.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'git status' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Permission flow complete.'),
    ]);
    const sessionID = await rootId(worker);
    const askedEvent = waitForGlobalEventContaining(worker, ['permission.asked', 'git status']);

    const prompt = request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: mintWireMessageId({ nowMs: Date.now() + 1_000 }).id,
        parts: [{ type: 'text', text: 'Inspect the repository.' }],
      }),
    });
    await askedEvent;

    const pending = (await (await request(worker, '/permission')).json()) as Array<{
      id: string;
      sessionID: string;
      permission: string;
      patterns: string[];
    }>;
    expect(pending).toEqual([
      expect.objectContaining({
        sessionID,
        permission: 'bash',
        patterns: ['git status'],
      }),
    ]);
    expect(rpcCalls).toEqual([]);
    const pendingPermission = pending[0];
    if (!pendingPermission) throw new Error('expected one pending permission');

    const invalid = await request(worker, `/permission/${pendingPermission.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: 'later' }),
    });
    expect(invalid.status).toBe(400);
    expect(rpcCalls).toEqual([]);
    expect(await (await request(worker, '/permission')).json()).toHaveLength(1);

    const repliedEvent = waitForGlobalEventContaining(worker, [
      'permission.replied',
      pendingPermission.id,
      'once',
    ]);
    const reply = await request(worker, `/permission/${pendingPermission.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reply: 'once' }),
    });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toBe(true);
    await repliedEvent;

    const response = await prompt;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { parts: Array<{ text?: string }> }).parts[0]?.text).toBe(
      'Permission flow complete.',
    );
    expect(rpcCalls).toEqual([expect.objectContaining({ op: 'exec' })]);
    expect(await (await request(worker, '/permission')).json()).toEqual([]);
  });

  test('POST /session/:id/message blocks and returns the assistant wire message', async () => {
    const worker = await start();
    await prime(worker, ['blocking answer']);
    const sessionID = await rootId(worker);
    const userID = 'msg_01990f4ca010abcdefghijklmn';

    const response = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: userID,
        parts: [{ type: 'text', text: 'blocking question' }],
      }),
    });

    expect(response.status).toBe(200);
    const assistant = (await response.json()) as {
      info: AssistantMessage;
      parts: Array<{ type: string; text?: string }>;
    };
    expect(assistant.info.role).toBe('assistant');
    expect(assistant.info.parentID).toBe(userID);
    expect(assistant.parts.map((part) => part.text ?? '').join('')).toBe('blocking answer');
    expectV2AssistantInfo(assistant.info);

    const rawResponse = await request(worker, `/session/${sessionID}/message/${assistant.info.id}`);
    const raw = (await rawResponse.json()) as { info: AssistantMessage };
    expect(rawResponse.status).toBe(200);
    expectV2AssistantInfo(raw.info);

    const transcript = (await (
      await request(worker, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{ info: UserMessage | AssistantMessage }>;
    const user = requireValue(
      transcript.find((message) => message.info.id === userID),
      'user transcript message',
    ).info as UserMessage;
    expect(user.agent).toBe('build');
    expect(user.model).toEqual({ providerID: 'faux', modelID: 'faux-1' });
  });

  test('a failed provider stream settles the turn and does not block the next queued turn', async () => {
    const worker = await start();
    await prime(worker, ['recovered answer']);
    const originalStream = worker.agent.streamFunction;
    let first = true;
    worker.agent.streamFunction = ((...args: Parameters<typeof originalStream>) => {
      if (!first) return originalStream(...args);
      first = false;
      const broken = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error('provider stream exploded');
            },
          };
        },
        async result() {
          throw new Error('provider result exploded');
        },
      } as unknown as AssistantMessageEventStream;
      return tapFirstToken(broken, () => {}, args[0]);
    }) as typeof originalStream;
    const sessionID = await rootId(worker);
    const idClock = Date.now() + 10_000;
    const firstID = mintWireMessageId({ nowMs: idClock }).id;
    const secondID = mintWireMessageId({ nowMs: idClock + 10_000 }).id;

    const failed = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'fail once' }] }),
    });
    expect(failed.status).toBe(200);
    expect(((await failed.json()) as { info: AssistantMessage }).info.error).toMatchObject({
      name: 'UnknownError',
      data: { message: 'provider stream exploded' },
    });

    const recovered = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: secondID,
        parts: [{ type: 'text', text: 'continue after failure' }],
      }),
    });
    expect(recovered.status).toBe(200);
    expect(
      ((await recovered.json()) as { parts: Array<{ text?: string }> }).parts
        .map((part) => part.text ?? '')
        .join(''),
    ).toBe('recovered answer');
  });

  test('accepts the gateway model key sent by the web client', async () => {
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      modelId: 'anthropic/claude-sonnet-4.5',
      sessionId: 'gateway-model-key',
      kortixToken: 'runtime-token',
    });
    workers.push(worker);
    await prime(worker, ['matched']);
    const sessionID = await rootId(worker);
    const messageID = 'msg_01990f4ca012abcdefghijklmn';

    const response = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID,
        agent: 'build',
        model: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5' },
        parts: [{ type: 'text', text: 'use the selected model' }],
      }),
    });

    expect(response.status).toBe(200);
    const assistant = (await response.json()) as { info: AssistantMessage };
    expect({
      providerID: assistant.info.providerID,
      modelID: assistant.info.modelID,
    }).toEqual({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4.5' });
    const messages = (await (
      await request(worker, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{ info: UserMessage | AssistantMessage }>;
    const userMessage = requireValue(
      messages.find((message) => message.info.id === messageID),
      'gateway user message',
    );
    expect((userMessage.info as UserMessage).model).toEqual({
      providerID: 'kortix',
      modelID: 'anthropic/claude-sonnet-4.5',
    });

    const state = (await (await request(worker, '/kortix/opencode/state')).json()) as {
      config: { value: { model: string | null } };
    };
    expect(state.config.value.model).toBe('kortix/anthropic/claude-sonnet-4.5');
  });

  test('preserves UTF-8 text when a code point crosses HTTP chunks', async () => {
    const worker = await start();
    await prime(worker, ['unicode answer']);
    const sessionID = await rootId(worker);
    const text = 'ship 🚀 café';
    const encoded = Buffer.from(
      JSON.stringify({
        messageID: 'msg_01990f4ca013abcdefghijklmn',
        parts: [{ type: 'text', text }],
      }),
    );
    const emoji = Buffer.from('🚀');
    const split = encoded.indexOf(emoji) + 2;

    const response = await chunkedRequest(worker, `/session/${sessionID}/message`, [
      encoded.subarray(0, split),
      encoded.subarray(split),
    ]);

    expect(response.status).toBe(200);
    const user = worker.agent.state.messages.filter((message) => message.role === 'user').pop() as
      | { content: Array<{ text?: string }> }
      | undefined;
    expect(user?.content[0]?.text).toBe(text);
  });

  test('rejects a chunked prompt body above the bounded admission limit', async () => {
    const worker = await start();
    const sessionID = await rootId(worker);
    const before = worker.agent.state.messages.length;
    const response = await chunkedRequest(worker, `/session/${sessionID}/prompt_async`, [
      Buffer.from('{"parts":[{"type":"text","text":"'),
      Buffer.alloc(600 * 1024, 120),
      Buffer.from('"}]}'),
    ]);

    expect(response.status).toBe(413);
    expect(JSON.parse(response.body).error).toBe('prompt body exceeds 524288 bytes');
    expect(worker.agent.state.messages).toHaveLength(before);
  });

  test('returns 400 for malformed encoded paths and keeps serving health', async () => {
    const worker = await start();
    for (const [path, method] of [
      ['/session/%E0%A4%A/message', 'GET'],
      ['/session/%E0%A4%A/prompt_async', 'POST'],
      ['/kortix/opencode/messages/%E0%A4%A', 'GET'],
    ] as const) {
      const response = await request(worker, path, {
        method,
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: '{"parts":[]}' }
          : {}),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'path contains malformed percent-encoding',
      });
    }
    expect((await request(worker, '/health')).status).toBe(200);
  });

  test('does not expose benchmark prompt routes in a deployed worker', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'deployed-bench-disabled',
      projectId: 'project-1',
      kortixToken: 'runtime-token',
      storeUrl,
    });
    workers.push(worker);

    for (const path of ['/prompt', '/turn', '/say']) {
      const response = await request(worker, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'must not run' }),
      });
      expect(response.status).toBe(404);
    }
    expect(worker.agent.state.messages).toHaveLength(0);
  });

  test('benchmark turn rejects malformed and oversized JSON before opening SSE', async () => {
    const worker = await start();
    const malformed = await request(worker, '/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('application/json');

    const oversized = await request(worker, '/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(600 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('content-type')).toContain('application/json');
    for (const invalid of [null, [], 'x', { text: 1 }]) {
      const response = await request(worker, '/turn', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invalid),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect((await (await request(worker, '/health')).json()).ok).toBe(true);
  });

  test('rejects oversized open request bodies before the client sends EOF', async () => {
    const worker = await start();
    const sessionID = await rootId(worker);
    for (const path of ['/turn', `/session/${sessionID}/prompt_async`]) {
      const response = await openEndedOversizedRequest(worker, path);
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body).error).toContain('exceeds 524288 bytes');
    }
    expect(worker.agent.state.messages).toHaveLength(0);
  });

  test('refuses a deployed session identity without a durable store', async () => {
    await expect(
      startWorker({
        port: 0,
        envUrl: 'http://127.0.0.1:1',
        envUrlExplicit: true,
        envCwd: '/workspace',
        envTransport: 'fetch',
        systemPrompt: 'Answer exactly.',
        modelMode: 'faux',
        sessionId: 'deployed-without-store',
        projectId: 'project-1',
        kortixToken: 'runtime-token',
      }),
    ).rejects.toThrow('deployed Pi sessions require KORTIX_STORE_URL');
  });

  test('coalesces an exact messageID retry and rejects conflicting content', async () => {
    const worker = await start();
    await prime(worker, ['only answer']);
    const sessionID = await rootId(worker);
    const transcript = await request(worker, `/session/${sessionID}/message`);
    expect(transcript.headers.get('x-kortix-prompt-admission')).toBeNull();
    const messageID = 'msg_01990f4ca015abcdefghijklmn';
    const send = (text: string) =>
      request(worker, `/session/${sessionID}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID, parts: [{ type: 'text', text }] }),
      });

    const first = await send('same input');
    expect(first.status).toBe(200);
    const firstAssistant = await first.json();

    const retry = await send('same input');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(firstAssistant);
    expect(
      worker.agent.state.messages.filter((message) => agentMessageHasText(message, 'same input')),
    ).toHaveLength(1);

    const conflict = await send('different input');
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toContain('conflicting content');
  });

  test('rejects a new explicit messageID below the durable transcript floor', async () => {
    const worker = await start();
    await prime(worker, ['newer answer']);
    const sessionID = await rootId(worker);
    const newerID = 'msg_01990f4ca030abcdefghijklmn';
    const olderID = 'msg_01990f4ca020abcdefghijklmn';
    const send = (messageID: string, text: string) =>
      request(worker, `/session/${sessionID}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID, parts: [{ type: 'text', text }] }),
      });

    expect((await send(newerID, 'newer')).status).toBe(200);
    const response = await send(olderID, 'older');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'messageID must sort after the durable transcript',
    });
    expect(
      worker.agent.state.messages.some(
        (message) => agentMessageRecord(message).kortixWireMessageId === olderID,
      ),
    ).toBe(false);
  });

  test('admits two increasing messageIDs that share one wire clock', async () => {
    const worker = await start();
    await prime(worker, ['first answer', 'second answer']);
    const releaseProvider = deferred();
    const providerReached = deferred();
    const originalStream = worker.agent.streamFunction;
    let firstStream = true;
    worker.agent.streamFunction = ((...args: Parameters<typeof originalStream>) => {
      const inner = originalStream(...args) as ReturnType<typeof createAssistantMessageEventStream>;
      if (!firstStream) return inner;
      firstStream = false;
      const held = createAssistantMessageEventStream();
      void (async () => {
        providerReached.resolve();
        await releaseProvider.promise;
        for await (const event of inner) held.push(event);
        held.end(await inner.result());
      })();
      return held;
    }) as typeof originalStream;
    const sessionID = await rootId(worker);
    const firstID = 'msg_01990f4ca032AAAAAAAAAAAAAA';
    const secondID = 'msg_01990f4ca032BBBBBBBBBBBBBB';
    const send = (messageID: string, text: string) =>
      request(worker, `/session/${sessionID}/prompt_async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID, parts: [{ type: 'text', text }] }),
      });

    const first = await send(firstID, 'first same-clock input');
    await providerReached.promise;
    const second = await send(secondID, 'second same-clock input');
    expect([first.status, second.status]).toEqual([204, 204]);
    releaseProvider.resolve();
    await worker.agent.waitForIdle();

    const messages = (await (
      await request(worker, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{ info: { id: string; role: string } }>;
    expect(
      messages.filter((message) => message.info.role === 'user').map((message) => message.info.id),
    ).toEqual([firstID, secondID]);
  });

  test('rejects a delayed same-clock user id after an assistant advanced the transcript', async () => {
    const worker = await start();
    await prime(worker, ['first answer']);
    const sessionID = await rootId(worker);
    const firstID = 'msg_01990f4ca033AAAAAAAAAAAAAA';
    const delayedID = 'msg_01990f4ca033BBBBBBBBBBBBBB';

    const completed = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'first' }] }),
    });
    expect(completed.status).toBe(200);

    const delayed = await request(worker, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: delayedID,
        parts: [{ type: 'text', text: 'arrived after the reply' }],
      }),
    });
    expect(delayed.status).toBe(409);
    expect((await delayed.json()).error).toBe('messageID must sort after the durable transcript');
  });

  test('prompt_async rejects input it cannot preserve instead of silently dropping it', async () => {
    const worker = await start();
    const sessionID = await rootId(worker);

    const response = await request(worker, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        variant: 'high',
        parts: [{ type: 'file', mime: 'text/plain', url: 'data:text/plain,secret' }],
      }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('not supported');
  });

  test('prompt_async rejects a workspace query that differs from the compiled environment', async () => {
    const worker = await start();
    const sessionID = await rootId(worker);

    const response = await request(
      worker,
      `/session/${sessionID}/prompt_async?directory=${encodeURIComponent('/other')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'do not run' }] }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'prompt workspace must equal the compiled environment workspace',
    });
    expect(worker.agent.state.messages).toHaveLength(0);

    const matching = await request(
      worker,
      `/session/${sessionID}/prompt_async?directory=${encodeURIComponent('/workspace')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'run here' }] }),
      },
    );
    expect(matching.status).toBe(204);
  });

  test('rejects an oversized durable admission without poisoning the next turn', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        items.push(JSON.parse(body) as SessionLogItem);
        res.writeHead(204).end();
      }),
    );
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'oversized-admission',
      kortixToken: 'runtime-token',
      storeUrl,
    });
    workers.push(worker);
    await prime(worker, ['small answer']);
    const sessionID = await rootId(worker);
    const oversizedID = 'msg_01990f4ca008abcdefghijklmn';

    const oversized = await request(worker, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: oversizedID,
        parts: [{ type: 'text', text: 'x'.repeat(300 * 1024) }],
      }),
    });

    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toContain('maximum is 524288');
    expect((await (await request(worker, '/health')).json()).ok).toBe(true);
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'accepted' &&
          (item.record.turn as { messageId?: string }).messageId === oversizedID,
      ),
    ).toBe(false);

    const small = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: 'msg_01990f4ca009opqrstuvwxyzAB',
        parts: [{ type: 'text', text: 'still works' }],
      }),
    });
    expect(small.status).toBe(200);
    expect((await small.json()).parts[0].text).toBe('small answer');
  });

  test('a worker-minted user id becomes the assistant parent id', async () => {
    const worker = await start();
    await prime(worker, ['async answer']);
    const sessionID = await rootId(worker);

    const accepted = await request(worker, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'mint an id' }] }),
    });
    expect(accepted.status).toBe(204);

    let messages: Array<{
      info: { id: string; role: string; parentID?: string };
      parts: Array<{ text?: string }>;
    }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      messages = (await (
        await request(worker, `/session/${sessionID}/message?limit=20`)
      ).json()) as typeof messages;
      if (messages.some((message) => message.info.role === 'assistant' && message.info.parentID))
        break;
      await Bun.sleep(10);
    }
    const user = messages.find(
      (message) =>
        message.info.role === 'user' && message.parts.some((part) => part.text === 'mint an id'),
    );
    const assistant = messages.find(
      (message) => message.info.role === 'assistant' && message.info.parentID === user?.info.id,
    );
    expect(user).toBeDefined();
    expect(assistant).toBeDefined();
  });

  test('does not return prompt_async 204 until durable admission commits', async () => {
    const appendGate = deferred();
    const appendReached = deferred();
    const items: SessionLogItem[] = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const item = JSON.parse(body) as SessionLogItem;
        if (item.kind === 'journal' && item.record.type === 'accepted') {
          appendReached.resolve();
          await appendGate.promise;
        }
        items.push(item);
        res.writeHead(204).end();
      }),
    );
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'durable-admission',
      kortixToken: 'runtime-token',
      storeUrl,
    });
    workers.push(worker);
    const sessionID = await rootId(worker);
    const transcript = await request(worker, `/session/${sessionID}/message`);
    expect(transcript.headers.get('x-kortix-prompt-admission')).toBe('durable-message-id-v1');
    let settled = 0;
    const prompt = () =>
      request(worker, `/session/${sessionID}/prompt_async`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageID: 'msg_01990f4ca020abcdefghijklmn',
          parts: [{ type: 'text', text: 'persist before accepting' }],
        }),
      }).then((response) => {
        settled += 1;
        return response;
      });
    const responsePromise = prompt();

    await appendReached.promise;
    await Bun.sleep(10);
    const concurrentRetry = prompt();
    await Bun.sleep(10);
    expect(settled).toBe(0);
    expect(items.some((item) => item.kind === 'journal')).toBe(false);

    appendGate.resolve();
    const [response, retry] = await Promise.all([responsePromise, concurrentRetry]);
    expect(response.status).toBe(204);
    expect(retry.status).toBe(204);
    expect(
      items.filter(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'accepted' &&
          (item.record.turn as { messageId?: string }).messageId ===
            'msg_01990f4ca020abcdefghijklmn',
      ),
    ).toHaveLength(1);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const started = worker.agent.state.messages.some((message) =>
        agentMessageHasText(message, 'persist before accepting'),
      );
      if (started) break;
      await Bun.sleep(5);
    }
    await worker.agent.waitForIdle();
    expect(
      worker.agent.state.messages.filter((message) =>
        agentMessageHasText(message, 'persist before accepting'),
      ),
    ).toHaveLength(1);
  });

  test('a second worker waits for and hydrates the preceding durable turn', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'shared-worker-order',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const [first, second] = await Promise.all([startWorker(config), startWorker(config)]);
    workers.push(first, second);
    requireValue(first.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('first durable answer'),
    ]);
    await prime(second, ['second answer']);
    const sessionID = await rootId(first);
    const firstID = mintWireMessageId({ nowMs: Date.now() }).id;
    const secondID = mintWireMessageId({ nowMs: Date.now() + 1 }).id;

    const firstAccepted = await request(first, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'first' }] }),
    });
    expect(firstAccepted.status).toBe(204);
    await envReached.promise;

    let secondSettled = false;
    const secondResponse = request(second, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: secondID, parts: [{ type: 'text', text: 'second' }] }),
    }).then((response) => {
      secondSettled = true;
      return response;
    });
    await Bun.sleep(50);
    expect(secondSettled).toBe(false);
    expect(second.agent.state.messages).toHaveLength(0);

    releaseEnv.resolve();
    const response = await secondResponse;
    expect(response.status).toBe(200);
    expect(((await response.json()) as { parts: Array<{ text?: string }> }).parts[0]?.text).toBe(
      'second answer',
    );
    const texts = second.agent.state.messages.map(agentMessageText);
    expect(texts).toEqual(expect.arrayContaining(['first', 'first durable answer', 'second']));
    expect(texts.indexOf('first durable answer')).toBeLessThan(texts.indexOf('second'));
  });

  test('a replacement waits for a live owner heartbeat instead of interrupting its turn', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'live-owner-handoff',
      kortixToken: 'runtime-token',
      storeUrl,
      turnOwnerHeartbeatMs: 10,
      turnOwnerLeaseMs: 50,
    };
    const first = await startWorker(config);
    workers.push(first);
    requireValue(first.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('owner completed'),
    ]);
    const sessionID = await rootId(first);
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
    expect(
      (
        await request(first, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'finish once' }] }),
        })
      ).status,
    ).toBe(204);
    await envReached.promise;

    let replacementSettled = false;
    const replacementPromise = startWorker(config).then((worker) => {
      replacementSettled = true;
      workers.push(worker);
      return worker;
    });
    await Bun.sleep(120);
    expect(replacementSettled).toBe(false);
    expect(items.some((item) => item.kind === 'journal' && item.record.type === 'heartbeat')).toBe(
      true,
    );

    releaseEnv.resolve();
    await first.agent.waitForIdle();
    const replacement = await replacementPromise;
    const transcript = (await (
      await request(replacement, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{ info: { role: string }; parts: Array<{ text?: string }> }>;
    expect(JSON.stringify(transcript)).toContain('owner completed');
    expect(JSON.stringify(transcript)).not.toContain('interrupted when the worker restarted');
    expect(items.some((item) => item.kind === 'journal' && item.record.type === 'reclaimed')).toBe(
      false,
    );
  });

  test('a worker revalidates ownership after hydration before entering the model', async () => {
    const hydrateReached = deferred();
    const releaseHydrate = deferred();
    const items: SessionLogItem[] = [];
    const byKey = new Map<string, SessionLogItem>();
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
    let blockOwnerHydrate = false;
    let ownerHydrateBlocked = false;
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          if (blockOwnerHydrate && !ownerHydrateBlocked) {
            ownerHydrateBlocked = true;
            hydrateReached.resolve();
            await releaseHydrate.promise;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const item = JSON.parse(body) as SessionLogItem;
        const key = String(req.headers['idempotency-key'] ?? '');
        const existing = key ? byKey.get(key) : undefined;
        if (existing) {
          if (!isDeepStrictEqual(existing, item)) {
            res.writeHead(409).end();
            return;
          }
          res.writeHead(204).end();
          return;
        }
        const clone = structuredClone(item);
        if (key) byKey.set(key, clone);
        items.push(clone);
        if (
          item.kind === 'journal' &&
          item.record.type === 'started' &&
          item.record.messageId === messageID
        ) {
          blockOwnerHydrate = true;
        }
        res.writeHead(204).end();
      }),
    );
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'hydrate-owner-fence',
      kortixToken: 'runtime-token',
      storeUrl,
      turnOwnerHeartbeatMs: 1_000,
      turnOwnerLeaseMs: 40,
    };
    const owner = await startWorker(config);
    workers.push(owner);
    await prime(owner, ['must not execute after reclaim']);
    let modelCalls = 0;
    const stream = owner.agent.streamFunction;
    owner.agent.streamFunction = ((...args: Parameters<typeof stream>) => {
      modelCalls += 1;
      return stream(...args);
    }) as typeof stream;
    const sessionID = await rootId(owner);
    const ownerResponse = request(owner, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID,
        parts: [{ type: 'text', text: 'do not cross a reclaimed lease' }],
      }),
    });
    await hydrateReached.promise;

    const replacement = await startWorker(config);
    workers.push(replacement);
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'reclaimed' &&
          item.record.messageId === messageID,
      ),
    ).toBe(true);

    releaseHydrate.resolve();
    expect((await ownerResponse).status).toBe(503);
    expect(modelCalls).toBe(0);
    expect(JSON.stringify(owner.agent.state.messages)).not.toContain(
      'must not execute after reclaim',
    );
  });

  test('boot restores the transcript and journal from one durable snapshot', async () => {
    const providerReached = deferred();
    const releaseProvider = deferred();
    const replacementSecondReadReached = deferred();
    const releaseReplacementSecondRead = deferred();
    const items: SessionLogItem[] = [];
    const byKey = new Map<string, SessionLogItem>();
    let replacementReads = 0;
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          if (req.headers['x-test-worker'] === 'replacement') {
            replacementReads += 1;
            if (replacementReads === 2) {
              replacementSecondReadReached.resolve();
              await releaseReplacementSecondRead.promise;
            }
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const item = JSON.parse(body) as SessionLogItem;
        const key = String(req.headers['idempotency-key'] ?? '');
        const existing = key ? byKey.get(key) : undefined;
        if (existing) {
          if (!isDeepStrictEqual(existing, item)) {
            res.writeHead(409).end();
            return;
          }
          res.writeHead(204).end();
          return;
        }
        const clone = structuredClone(item);
        if (key) byKey.set(key, clone);
        items.push(clone);
        res.writeHead(204).end();
      }),
    );
    const baseConfig = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'single-bootstrap-snapshot',
      kortixToken: 'runtime-token',
      storeUrl,
      turnOwnerHeartbeatMs: 5,
      turnOwnerLeaseMs: 40,
    };
    const owner = await startWorker({
      ...baseConfig,
      storeHeaders: { 'x-test-worker': 'owner' },
    });
    workers.push(owner);
    await prime(owner, ['answer committed between bootstrap reads']);
    const originalStream = owner.agent.streamFunction;
    owner.agent.streamFunction = ((...args: Parameters<typeof originalStream>) => {
      const inner = originalStream(...args) as ReturnType<typeof createAssistantMessageEventStream>;
      const held = createAssistantMessageEventStream();
      void (async () => {
        providerReached.resolve();
        await releaseProvider.promise;
        for await (const event of inner) held.push(event);
        held.end(await inner.result());
      })();
      return held;
    }) as typeof originalStream;
    const sessionID = await rootId(owner);
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;

    expect(
      (
        await request(owner, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messageID,
            parts: [{ type: 'text', text: 'finish during replacement bootstrap' }],
          }),
        })
      ).status,
    ).toBe(204);
    await providerReached.promise;

    const replacementPromise = startWorker({
      ...baseConfig,
      storeHeaders: { 'x-test-worker': 'replacement' },
    });
    await replacementSecondReadReached.promise;
    releaseProvider.resolve();
    await owner.agent.waitForIdle();
    await waitUntil(() =>
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === messageID,
      ),
    );
    releaseReplacementSecondRead.resolve();

    const replacement = await replacementPromise;
    workers.push(replacement);
    const transcript = await (
      await request(replacement, `/session/${sessionID}/message?limit=20`)
    ).json();
    expect(JSON.stringify(transcript)).toContain('answer committed between bootstrap reads');
  });

  for (const route of [
    { name: 'raw', path: (sessionID: string) => `/session/${sessionID}/abort` },
    {
      name: 'prefixed',
      path: (sessionID: string) => `/kortix/opencode/session/${sessionID}/abort`,
    },
  ]) {
    test(`${route.name} Stop reaches a turn owned by another worker and status is durable`, async () => {
      const envReached = deferred();
      const releaseEnv = deferred();
      const envUrl = await listen(
        createServer(async (req, res) => {
          let body = '';
          for await (const chunk of req) body += chunk;
          const rpc = JSON.parse(body) as { op?: string };
          if (req.url === '/cancel') {
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ ok: true, value: { cancelled: true } }));
            return;
          }
          if (rpc.op === 'exec') {
            envReached.resolve();
            await releaseEnv.promise;
          }
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
        }),
      );
      const items: SessionLogItem[] = [];
      const storeUrl = await sharedStore(items);
      const config = {
        port: 0,
        envUrl,
        envUrlExplicit: true,
        envCwd: '/workspace',
        envTransport: 'fetch' as const,
        systemPrompt: 'Answer exactly.',
        modelMode: 'faux' as const,
        sessionId: `cross-worker-abort-${route.name}`,
        kortixToken: 'runtime-token',
        storeUrl,
        turnAbortPollMs: 5,
        turnOwnerHeartbeatMs: 10,
        turnOwnerLeaseMs: 100,
      };
      const [owner, remote] = await Promise.all([startWorker(config), startWorker(config)]);
      workers.push(owner, remote);
      requireValue(owner.faux, 'faux model').setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('must not complete after remote Stop'),
      ]);
      const sessionID = await rootId(owner);
      const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
      expect(
        (
          await request(owner, `/session/${sessionID}/prompt_async`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'stop me' }] }),
          })
        ).status,
      ).toBe(204);
      await envReached.promise;

      expect(await (await request(remote, '/session/status')).json()).toEqual({
        [sessionID]: { type: 'busy' },
      });
      const stopped = await request(remote, route.path(sessionID), { method: 'POST' });
      expect(stopped.status).toBe(200);
      await waitUntil(() =>
        items.some(
          (item) =>
            item.kind === 'journal' &&
            item.record.type === 'abort_requested' &&
            item.record.messageId === messageID,
        ),
      );
      await Bun.sleep(15);
      releaseEnv.resolve();
      await owner.agent.waitForIdle();
      await waitUntil(() =>
        items.some(
          (item) =>
            item.kind === 'journal' &&
            item.record.type === 'completed' &&
            item.record.messageId === messageID,
        ),
      );

      expect(
        items.filter(
          (item) =>
            item.kind === 'journal' &&
            item.record.type === 'abort_requested' &&
            item.record.messageId === messageID,
        ),
      ).toHaveLength(1);
      expect(
        items.find(
          (item) =>
            item.kind === 'journal' &&
            item.record.type === 'completed' &&
            item.record.messageId === messageID,
        ),
      ).toMatchObject({ record: { status: 'error' } });
      expect(JSON.stringify(owner.agent.state.messages)).not.toContain(
        'must not complete after remote Stop',
      );
      expect(await (await request(remote, '/session/status')).json()).toEqual({});
      const transcript = await (await request(owner, `/session/${sessionID}/message`)).json() as
        Array<{ info: AssistantMessage | UserMessage }>;
      const terminal = transcript.filter((message) => message.info.role === 'assistant').at(-1);
      expect((terminal?.info as AssistantMessage).error?.name).toBe('MessageAbortedError');
      expect((terminal?.info as AssistantMessage).time.completed).toBeNumber();
      const restarted = await startWorker(config);
      workers.push(restarted);
      const restored = await (await request(restarted, `/session/${sessionID}/message`)).json() as
        Array<{ info: AssistantMessage | UserMessage }>;
      expect(restored.find((message) => message.info.id === terminal?.info.id)?.info)
        .toEqual(terminal?.info);
    });
  }

  test('a waiting worker reclaims an abandoned head and fences late owner persistence', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'abandoned-live-head',
      kortixToken: 'runtime-token',
      storeUrl,
      // Force expiry in the test. Production heartbeats every 10 seconds and
      // uses a 60-second unchanged-observation lease.
      turnOwnerHeartbeatMs: 1_000,
      turnOwnerLeaseMs: 40,
    };
    const [owner, waiter] = await Promise.all([
      startWorker({ ...config, turnOwnerLeaseMs: 10000 }),
      startWorker(config),
    ]);
    workers.push(owner, waiter);
    requireValue(owner.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('late owner answer must not persist'),
    ]);
    await prime(waiter, ['second answer after recovery']);
    const sessionID = await rootId(owner);
    const firstID = mintWireMessageId({ nowMs: Date.now() }).id;
    const secondID = mintWireMessageId({ nowMs: Date.now() + 10_000 }).id;
    expect(
      (
        await request(owner, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'first' }] }),
        })
      ).status,
    ).toBe(204);
    await envReached.promise;

    const second = await request(waiter, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID: secondID, parts: [{ type: 'text', text: 'second' }] }),
    });
    expect(second.status).toBe(200);
    expect(JSON.stringify(await second.json())).toContain('second answer after recovery');
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'reclaimed' &&
          item.record.messageId === firstID,
      ),
    ).toBe(true);

    releaseEnv.resolve();
    await waitUntil(() => !owner.agent.state.isStreaming);
    await Bun.sleep(25);
    const activeTranscript = (await (
      await request(waiter, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{
      info: { role: string; parentID?: string };
      parts: Array<{ text?: string }>;
    }>;
    const firstReplies = activeTranscript.filter(
      (message) => message.info.role === 'assistant' && message.info.parentID === firstID,
    );
    expect(firstReplies).toHaveLength(1);
    expect(JSON.stringify(firstReplies)).toContain('interrupted when the worker restarted');
    expect(JSON.stringify(activeTranscript)).not.toContain('late owner answer must not persist');
  });

  test('reclaim fences a blocked stale transcript append before restart', async () => {
    const staleAppendReached = deferred();
    const releaseStaleAppend = deferred();
    const reconciliationReached = deferred();
    const releaseReconciliation = deferred();
    let blockReconciliation = false;
    let ownerRef: Awaited<ReturnType<typeof startWorker>> | undefined;
    const items: SessionLogItem[] = [];
    const byKey = new Map<string, SessionLogItem>();
    let blockedStaleAppend = false;
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          if (blockReconciliation && req.headers['x-test-worker'] === 'owner' && ownerRef && !ownerRef.agent.state.isStreaming) {
            reconciliationReached.resolve();
            await releaseReconciliation.promise;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const item = JSON.parse(body) as SessionLogItem;
        const isStaleAssistantEntry =
          item.kind === 'entry' && JSON.stringify(item.entry).includes('blocked stale answer');
        if (isStaleAssistantEntry && !blockedStaleAppend) {
          blockedStaleAppend = true;
          staleAppendReached.resolve();
          await releaseStaleAppend.promise;
        }
        const key = String(req.headers['idempotency-key'] ?? '');
        const existing = key ? byKey.get(key) : undefined;
        if (existing) {
          if (!isDeepStrictEqual(existing, item)) {
            res.writeHead(409).end();
            return;
          }
          res.writeHead(204).end();
          return;
        }
        const clone = structuredClone(item);
        if (key) byKey.set(key, clone);
        items.push(clone);
        res.writeHead(204).end();
      }),
    );
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'stale-transcript-append-fence',
      kortixToken: 'runtime-token',
      storeUrl,
      turnOwnerHeartbeatMs: 1_000,
      turnOwnerLeaseMs: 40,
    };
    const owner = await startWorker({ ...config, storeHeaders: { 'x-test-worker': 'owner' } });
    ownerRef = owner;
    workers.push(owner);
    const stream = await watchGlobalEvents(owner);
    await prime(owner, ['blocked stale answer']);
    const sessionID = await rootId(owner);
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;

    expect(
      (
        await request(owner, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messageID,
            parts: [{ type: 'text', text: 'fence this stale owner' }],
          }),
        })
      ).status,
    ).toBe(204);
    await staleAppendReached.promise;

    const replacement = await startWorker(config);
    workers.push(replacement);
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'reclaimed' &&
          item.record.messageId === messageID,
      ),
    ).toBe(true);

    blockReconciliation = true;
    releaseStaleAppend.resolve();
    try {
      await reconciliationReached.promise;
      const probe = await (await request(owner, `/kortix/health?turn=1&turn_message_id=${messageID}`)).json() as { turn_in_flight: boolean };
      expect(probe.turn_in_flight).toBe(true);
      expect(stream.events.filter((event) => event.type === 'session.idle')).toEqual([]);
      expect(await (await request(owner, '/session/status')).json()).toEqual({ [sessionID]: { type: 'busy' } });
    } finally {
      releaseReconciliation.resolve();
    }
    await waitUntil(async () => {
      const probe = await (await request(owner, `/kortix/health?turn=1&turn_message_id=${messageID}`)).json() as { turn_in_flight: boolean };
      return !probe.turn_in_flight;
    });
    await waitUntil(() => stream.events.some((event) => event.type === 'session.idle'));
    const removedAt = stream.events.findLastIndex((event) => event.type === 'message.removed');
    const idleAt = stream.events.findIndex((event) => event.type === 'session.idle');
    expect(removedAt).toBeGreaterThanOrEqual(0);
    expect(idleAt).toBeGreaterThan(removedAt);
    expect(stream.errors).toEqual([]);
    const ownerTranscript = await (
      await request(owner, `/session/${sessionID}/message?limit=20`)
    ).json();
    const restarted = await startWorker(config);
    workers.push(restarted);
    const transcript = await (
      await request(restarted, `/session/${sessionID}/message?limit=20`)
    ).json();

    expect(JSON.stringify(ownerTranscript)).not.toContain('blocked stale answer');
    expect(JSON.stringify(transcript)).toContain('interrupted when the worker restarted');
    expect(JSON.stringify(transcript)).not.toContain('blocked stale answer');
    expect(JSON.stringify(items)).not.toContain('blocked stale answer');
  });

  test('an exact retry recovers an abandoned owner and advances every live worker floor', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'exact-retry-recovery',
      kortixToken: 'runtime-token',
      storeUrl,
      turnOwnerHeartbeatMs: 1_000,
      turnOwnerLeaseMs: 40,
    };
    const [owner, recovery, stale] = await Promise.all([
      startWorker({ ...config, turnOwnerLeaseMs: 10000 }),
      startWorker(config),
      startWorker(config),
    ]);
    workers.push(owner, recovery, stale);
    requireValue(owner.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('late owner answer must not persist'),
    ]);
    const sessionID = await rootId(owner);
    const minted = mintWireMessageId({ nowMs: Date.now() }).id;
    const clock = minted.slice(4, 16);
    const messageID = `msg_${clock}00000000000000`;
    const belowRecoveredAssistant = `msg_${clock}zzzzzzzzzzzzzz`;
    const body = JSON.stringify({
      messageID,
      parts: [{ type: 'text', text: 'recover this exact request' }],
    });
    expect(
      (
        await request(owner, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      ).status,
    ).toBe(204);
    await envReached.promise;

    const recovered = await request(recovery, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(recovered.status).toBe(200);
    const interruption = (await recovered.json()) as {
      info: { id: string; parentID: string };
      parts: Array<{ text?: string }>;
    };
    expect(interruption.info.parentID).toBe(messageID);
    expect(interruption.info.id > belowRecoveredAssistant).toBe(true);
    expect(JSON.stringify(interruption.parts)).toContain('interrupted when the worker restarted');

    const rejected = await request(stale, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: belowRecoveredAssistant,
        parts: [{ type: 'text', text: 'must stay below recovered output' }],
      }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: 'messageID must sort after the durable transcript',
    });

    releaseEnv.resolve();
    await waitUntil(() => !owner.agent.state.isStreaming);
    expect(
      items.filter(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === messageID,
      ),
    ).toHaveLength(1);
  });

  test('a stale worker hydrates an exact completed retry from the shared store', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'shared-worker-retry',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const [first, stale] = await Promise.all([startWorker(config), startWorker(config)]);
    workers.push(first, stale);
    await prime(first, ['remote durable answer']);
    const sessionID = await rootId(first);
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
    const body = JSON.stringify({
      messageID,
      parts: [{ type: 'text', text: 'execute remotely once' }],
    });

    const original = await request(first, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(original.status).toBe(200);

    const retry = await request(stale, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { parts: Array<{ text?: string }> }).parts[0]?.text).toBe(
      'remote durable answer',
    );
    expect(
      items.filter(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'started' &&
          item.record.messageId === messageID,
      ),
    ).toHaveLength(1);
  });

  test('a stale live worker hydrates a completed remote turn before starting a distinct turn', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'shared-worker-stale-context',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const [first, stale] = await Promise.all([startWorker(config), startWorker(config)]);
    workers.push(first, stale);
    await prime(first, ['first remote answer']);
    await prime(stale, ['second local answer']);
    const sessionID = await rootId(first);
    const firstID = mintWireMessageId({ nowMs: Date.now() }).id;
    const firstResponse = await request(first, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: firstID,
        parts: [{ type: 'text', text: 'first remote question' }],
      }),
    });
    expect(firstResponse.status).toBe(200);
    const firstAssistant = (await firstResponse.json()) as { info: { id: string } };
    const secondID = mintWireMessageId({
      nowMs: Date.now(),
      newestKnownTime: wireIdTime(firstAssistant.info.id),
    }).id;

    let providerContext: unknown[] = [];
    const staleStream = stale.agent.streamFunction;
    stale.agent.streamFunction = ((...args: Parameters<typeof staleStream>) => {
      providerContext = structuredClone((args[1] as { messages?: unknown[] }).messages ?? []);
      return staleStream(...args);
    }) as typeof staleStream;
    const response = await request(stale, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: secondID,
        parts: [{ type: 'text', text: 'second local question' }],
      }),
    });

    expect(response.status).toBe(200);
    const contextText = JSON.stringify(providerContext);
    expect(contextText).toContain('first remote question');
    expect(contextText).toContain('first remote answer');
    expect(contextText).toContain('second local question');
  });

  test('a stale worker rejects a lower id after another worker advances the durable floor', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'shared-worker-id-floor',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const [current, stale] = await Promise.all([startWorker(config), startWorker(config)]);
    workers.push(current, stale);
    await prime(current, ['newer answer']);
    await prime(stale, ['must not execute']);
    const sessionID = await rootId(current);
    const newerID = 'msg_01990f4ca020ZZZZZZZZZZZZZZ';
    const olderID = 'msg_01990f4ca010AAAAAAAAAAAAAA';

    expect(
      (
        await request(current, `/session/${sessionID}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messageID: newerID,
            parts: [{ type: 'text', text: 'newer durable input' }],
          }),
        })
      ).status,
    ).toBe(200);

    const rejected = await request(stale, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: olderID,
        parts: [{ type: 'text', text: 'older stale input' }],
      }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: 'messageID must sort after the durable transcript',
    });
    expect(
      stale.agent.state.messages.some((message) =>
        agentMessageHasText(message, 'older stale input'),
      ),
    ).toBe(false);
  });

  test('two workers return 409 for conflicting text under one message id', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'shared-worker-conflict',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const [first, second] = await Promise.all([startWorker(config), startWorker(config)]);
    workers.push(first, second);
    await prime(first, ['first answer']);
    await prime(second, ['second answer']);
    const sessionID = await rootId(first);
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
    const send = (worker: typeof first, text: string) =>
      request(worker, `/session/${sessionID}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageID, parts: [{ type: 'text', text }] }),
      });

    const responses = await Promise.all([
      send(first, 'first conflicting input'),
      send(second, 'second conflicting input'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const rejected = requireValue(
      responses.find((response) => response.status === 409),
      'conflict response',
    );
    expect((await rejected.json()).error).toContain('conflicting content');
    expect(
      items.filter((item) => item.kind === 'journal' && item.record.type === 'accepted'),
    ).toHaveLength(1);
  });

  test('a worker can cancel a pending turn admitted by another worker', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const items: SessionLogItem[] = [];
    const storeUrl = await sharedStore(items);
    const config = {
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'shared-worker-delete',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const [first, second] = await Promise.all([startWorker(config), startWorker(config)]);
    workers.push(first, second);
    requireValue(first.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('first done'),
    ]);
    await prime(second, ['second must not run']);
    const sessionID = await rootId(first);
    const firstID = mintWireMessageId({ nowMs: Date.now() }).id;
    const secondID = mintWireMessageId({ nowMs: Date.now() + 1 }).id;

    expect(
      (
        await request(first, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'first' }] }),
        })
      ).status,
    ).toBe(204);
    await envReached.promise;
    expect(
      (
        await request(second, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: secondID, parts: [{ type: 'text', text: 'second' }] }),
        })
      ).status,
    ).toBe(204);

    const removedEvent = waitForGlobalEvent(second, 'message.removed', secondID);
    await Bun.sleep(5);
    const deleted = await request(first, `/session/${sessionID}/message/${secondID}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toBe(true);
    releaseEnv.resolve();
    await first.agent.waitForIdle();
    expect(await removedEvent).toContain(secondID);
    await Bun.sleep(50);

    const ownerTranscript = (await (
      await request(second, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{ info: { id: string } }>;
    expect(ownerTranscript.some((message) => message.info.id === secondID)).toBe(false);
    expect(
      second.agent.state.messages.some((message) => agentMessageHasText(message, 'second')),
    ).toBe(false);
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'cancelled' &&
          item.record.messageId === secondID,
      ),
    ).toBe(true);
  });

  test('does not close the control-plane turn before durable completion commits', async () => {
    const messageID = 'msg_01990f4ca025abcdefghijklmn';
    const completionGate = deferred();
    const completionReached = deferred();
    const relayReached = deferred();
    const items: SessionLogItem[] = [];
    let relayCalls = 0;
    const controlUrl = await listen(
      createServer(async (req, res) => {
        if (req.url === '/projects/project-1/turn-stream') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const relay = JSON.parse(body) as { turn_message_id?: string };
          if (relay.turn_message_id === messageID) {
            relayCalls += 1;
            relayReached.resolve();
          }
          res.writeHead(200).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const item = JSON.parse(body) as SessionLogItem;
        if (
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === messageID
        ) {
          completionReached.resolve();
          await completionGate.promise;
        }
        items.push(item);
        res.writeHead(204).end();
      }),
    );
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'completion-before-relay',
      kortixToken: 'runtime-token',
      storeUrl: `${controlUrl}/projects/project-1`,
      apiUrl: controlUrl,
      projectId: 'project-1',
    });
    workers.push(worker);
    await prime(worker, ['durable answer']);
    const sessionID = await rootId(worker);
    const response = request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID,
        parts: [{ type: 'text', text: 'complete durably first' }],
      }),
    });

    await completionReached.promise;
    await Bun.sleep(10);
    expect(relayCalls).toBe(0);

    completionGate.resolve();
    expect((await response).status).toBe(200);
    await relayReached.promise;
    expect(relayCalls).toBe(1);
  });

  test('deleting a queued user message durably prevents model execution', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const worker = await startWorker({
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'queue-delete',
      kortixToken: 'runtime-token',
    });
    workers.push(worker);
    requireValue(worker.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('first done'),
      fauxAssistantMessage('second must not run'),
    ]);
    const sessionID = await rootId(worker);
    const idClock = Date.now() + 10_000;
    const firstID = mintWireMessageId({ nowMs: idClock }).id;
    const secondID = mintWireMessageId({ nowMs: idClock + 10_000 }).id;

    expect(
      (
        await request(worker, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'first' }] }),
        })
      ).status,
    ).toBe(204);
    await envReached.promise;
    expect(await (await request(worker, '/session/status')).json()).toEqual({
      [sessionID]: { type: 'busy' },
    });
    expect(
      (
        await request(worker, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: secondID, parts: [{ type: 'text', text: 'second' }] }),
        })
      ).status,
    ).toBe(204);

    const beforeDelete = (await (
      await request(worker, `/session/${sessionID}/message`)
    ).json()) as Array<{ info: { id: string } }>;
    expect(beforeDelete.some((message) => message.info.id === secondID)).toBe(true);
    const deleted = await request(worker, `/session/${sessionID}/message/${secondID}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toBe(true);

    releaseEnv.resolve();
    await worker.agent.waitForIdle();
    await Bun.sleep(10);
    expect(await (await request(worker, '/session/status')).json()).toEqual({});
    const afterDelete = (await (
      await request(worker, `/session/${sessionID}/message`)
    ).json()) as Array<{ info: { id: string } }>;
    expect(afterDelete.some((message) => message.info.id === secondID)).toBe(false);
    expect(
      worker.agent.state.messages.some((message) => agentMessageHasText(message, 'second')),
    ).toBe(false);
  });

  test('a poisoned durable log prevents the next queued turn from reaching the model', async () => {
    const envReached = deferred();
    const releaseEnv = deferred();
    const envUrl = await listen(
      createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const rpc = JSON.parse(body) as { op: string };
        if (rpc.op === 'exec') {
          envReached.resolve();
          await releaseEnv.promise;
        }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const idClock = Date.now() + 10_000;
    const firstID = mintWireMessageId({ nowMs: idClock }).id;
    const secondID = mintWireMessageId({ nowMs: idClock + 10_000 }).id;
    const items: SessionLogItem[] = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        const item = JSON.parse(body) as SessionLogItem;
        if (
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === firstID
        ) {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: 'completion rejected' }));
          return;
        }
        items.push(item);
        res.writeHead(204).end();
      }),
    );
    const worker = await startWorker({
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'poisoned-queue',
      kortixToken: 'runtime-token',
      storeUrl,
    });
    workers.push(worker);
    requireValue(worker.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('first done'),
      fauxAssistantMessage('second must not run'),
    ]);
    const sessionID = await rootId(worker);

    expect(
      (
        await request(worker, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: firstID, parts: [{ type: 'text', text: 'first' }] }),
        })
      ).status,
    ).toBe(204);
    await envReached.promise;
    expect(
      (
        await request(worker, `/session/${sessionID}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID: secondID, parts: [{ type: 'text', text: 'second' }] }),
        })
      ).status,
    ).toBe(204);

    releaseEnv.resolve();
    await worker.agent.waitForIdle();
    await Bun.sleep(25);
    expect(
      worker.agent.state.messages.some((message) => agentMessageHasText(message, 'second')),
    ).toBe(false);
    const rejected = await request(worker, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'third' }] }),
    });
    expect(rejected.status).toBe(503);
    expect((await rejected.json()).error).toContain('session log append failed');
    expect((await (await request(worker, '/health')).json()).ok).toBe(false);
  });

  test('an oversized assistant poisons durability before any later turn executes', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        items.push(JSON.parse(body) as SessionLogItem);
        res.writeHead(204).end();
      }),
    );
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch',
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux',
      sessionId: 'oversized-assistant',
      kortixToken: 'runtime-token',
      storeUrl,
    });
    workers.push(worker);
    await prime(worker, ['x'.repeat(600 * 1024), 'must not execute']);
    const sessionID = await rootId(worker);

    const first = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: 'msg_01990f4ca037AAAAAAAAAAAAAA',
        parts: [{ type: 'text', text: 'produce an oversized answer' }],
      }),
    });
    expect(first.status).toBe(503);
    expect((await first.json()).error).toContain('maximum is 524288');
    expect((await (await request(worker, '/health')).json()).ok).toBe(false);

    const second = await request(worker, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: 'msg_01990f4ca038BBBBBBBBBBBBBB',
        parts: [{ type: 'text', text: 'do not execute' }],
      }),
    });
    expect(second.status).toBe(503);
    expect(
      worker.agent.state.messages.some((message) => agentMessageHasText(message, 'do not execute')),
    ).toBe(false);
  }, 15_000);

  test('restart replay keeps one stable user id for an accepted turn that never started', async () => {
    const items: SessionLogItem[] = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        items.push(JSON.parse(body) as SessionLogItem);
        res.writeHead(204).end();
      }),
    );
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'restart-replay',
      kortixToken: 'runtime-token',
      storeUrl,
    };
    const first = await startWorker(config);
    workers.push(first);
    await prime(first, ['first attempt']);
    const sessionID = await rootId(first);
    const messageID = 'msg_01990f4ca040abcdefghijklmn';
    const sent = await request(first, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'replay me' }] }),
    });
    expect(sent.status).toBe(200);
    await waitUntil(() =>
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'relayed' &&
          item.record.messageId === messageID,
      ),
    );

    // Preserve the legacy crash shape this test covers: the user entered Pi's
    // tree while admission still looked pending. Current workers fence this
    // append after `started`, so remove its lease stamp when building the old
    // fixture.
    for (const item of items) {
      if (
        item.kind === 'entry' &&
        (item.entry as { message?: { kortixWireMessageId?: string } }).message
          ?.kortixWireMessageId === messageID
      ) {
        Reflect.deleteProperty(item, '_kortixTurnLease');
      }
    }
    const removed = items.filter(
      (item) =>
        (item.kind === 'journal' &&
          [
            'started',
            'heartbeat',
            'reclaimed',
            'abort_requested',
            'abort_acknowledged',
            'assistant',
            'completed',
            'relayed',
          ].includes(String(item.record.type)) &&
          item.record.messageId === messageID) ||
        (item.kind === 'entry' &&
          (item._kortixTurnLease?.messageId === messageID ||
            (item.entry as { message?: { kortixParentMessageId?: string } }).message
              ?.kortixParentMessageId === messageID)),
    );
    expect(
      removed
        .filter(
          (item): item is Extract<SessionLogItem, { kind: 'journal' }> => item.kind === 'journal',
        )
        .map((item) => String(item.record.type)),
    ).toEqual(expect.arrayContaining(['started', 'completed']));
    for (const item of removed) items.splice(items.indexOf(item), 1);

    const second = await startWorker(config);
    workers.push(second);
    await waitUntil(() =>
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === messageID,
      ),
    );
    const messages = (await (
      await request(second, `/session/${sessionID}/message`)
    ).json()) as Array<{ info: { id: string; role: string; parentID?: string } }>;

    expect(messages.filter((message) => message.info.id === messageID)).toHaveLength(1);
    expect(
      messages.some(
        (message) => message.info.role === 'assistant' && message.info.parentID === messageID,
      ),
    ).toBe(true);
    const replayMoves = items.filter((item) => item.kind === 'lane_move');
    expect(replayMoves).toHaveLength(1);
    expect(requireValue(replayMoves[0], 'replay lane move')._kortixTurnLease?.messageId).toBe(
      messageID,
    );
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === messageID,
      ),
    ).toBe(true);
  });

  test('boot reconciliation closes every legacy turn with its exact identity and status', async () => {
    const items: SessionLogItem[] = [];
    const relays: Array<Record<string, unknown>> = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.url === '/projects/project-1/turn-stream') {
          let body = '';
          for await (const chunk of req) body += chunk;
          relays.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(200).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        items.push(JSON.parse(body) as SessionLogItem);
        res.writeHead(204).end();
      }),
    );
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'legacy-boot-reconcile',
      kortixToken: 'runtime-token',
      storeUrl,
      apiUrl: storeUrl,
      projectId: 'project-1',
    };
    const first = await startWorker(config);
    workers.push(first);
    requireValue(first.faux, 'faux model').setResponses([
      fauxAssistantMessage('legacy success'),
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'legacy provider failed',
      }),
    ]);
    const sessionID = await rootId(first);
    const firstID = mintWireMessageId({ nowMs: Date.now() }).id;
    const firstResponse = await request(first, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: firstID,
        parts: [{ type: 'text', text: 'first legacy turn' }],
      }),
    });
    expect(firstResponse.status).toBe(200);
    const firstAssistant = (await firstResponse.json()) as { info: { id: string } };
    const secondID = mintWireMessageId({
      nowMs: Date.now(),
      newestKnownTime: wireIdTime(firstAssistant.info.id),
    }).id;
    const secondResponse = await request(first, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messageID: secondID,
        parts: [{ type: 'text', text: 'second legacy turn' }],
      }),
    });
    expect(secondResponse.status).toBe(200);
    await waitUntil(
      () =>
        items.filter((item) => item.kind === 'journal' && item.record.type === 'relayed').length ===
        2,
    );

    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = requireValue(items[index], 'legacy log item');
      if (item.kind === 'journal') {
        items.splice(index, 1);
      } else {
        // This fixture converts a current transcript into a pre-journal log.
        // Lease stamps are part of the journal protocol and did not exist in
        // the legacy shape this test asks the restart to reconcile.
        Reflect.deleteProperty(item, '_kortixTurnLease');
      }
    }
    relays.length = 0;
    const second = await startWorker(config);
    workers.push(second);
    await waitUntil(() => relays.length >= 2, 2_500);

    expect(relays).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'idle',
          turn_message_id: firstID,
          opencode_session_id: sessionID,
        }),
        expect.objectContaining({
          status: 'error',
          turn_message_id: secondID,
          opencode_session_id: sessionID,
        }),
      ]),
    );
  }, 5_000);

  test('restart does not replay a turn whose model boundary already committed', async () => {
    const items: SessionLogItem[] = [];
    const relays: Array<Record<string, unknown>> = [];
    const storeUrl = await listen(
      createServer(async (req, res) => {
        if (req.url === '/projects/project-1/turn-stream') {
          let body = '';
          for await (const chunk of req) body += chunk;
          relays.push(JSON.parse(body) as Record<string, unknown>);
          res.writeHead(200).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
          return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        items.push(JSON.parse(body) as SessionLogItem);
        res.writeHead(204).end();
      }),
    );
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Answer exactly.',
      modelMode: 'faux' as const,
      sessionId: 'started-no-replay',
      kortixToken: 'runtime-token',
      storeUrl,
      apiUrl: storeUrl,
      projectId: 'project-1',
      turnOwnerHeartbeatMs: 5,
      turnOwnerLeaseMs: 25,
    };
    const first = await startWorker(config);
    workers.push(first);
    await prime(first, ['one execution']);
    const sessionID = await rootId(first);
    const messageID = 'msg_01990f4ca045abcdefghijklmn';
    expect(
      (
        await request(first, `/session/${sessionID}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'execute once' }] }),
        })
      ).status,
    ).toBe(200);

    await waitUntil(() =>
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'relayed' &&
          item.record.messageId === messageID,
      ),
    );

    const terminalItems = items.filter(
      (item) =>
        (item.kind === 'journal' &&
          (item.record.type === 'assistant' ||
            item.record.type === 'completed' ||
            item.record.type === 'relayed') &&
          item.record.messageId === messageID) ||
        (item.kind === 'entry' &&
          (item.entry as { message?: { kortixParentMessageId?: string } }).message
            ?.kortixParentMessageId === messageID),
    );
    expect(terminalItems.length).toBeGreaterThan(0);
    for (const item of terminalItems) items.splice(items.indexOf(item), 1);
    relays.length = 0;

    const second = await startWorker(config);
    workers.push(second);
    expect(
      second.agent.state.messages.filter((message) => agentMessageHasText(message, 'execute once')),
    ).toHaveLength(1);
    expect(items.some((item) => item.kind === 'lane_move')).toBe(false);

    const messages = (await (
      await request(second, `/session/${sessionID}/message?limit=20`)
    ).json()) as Array<{
      info: AssistantMessage | UserMessage;
      parts: Array<{ type: string; text?: string }>;
    }>;
    const interrupted = requireValue(
      messages.find(
        (message) =>
          message.info.role === 'assistant' &&
          (message.info as AssistantMessage).parentID === messageID,
      ),
      'interrupted assistant message',
    );
    expect((interrupted.info as AssistantMessage).error).toEqual({
      name: 'MessageAbortedError',
      data: { message: 'The worker restarted before the turn reached a durable terminal state' },
    });
    expect(interrupted.parts.map((part) => part.text ?? '').join('')).toContain(
      'interrupted when the worker restarted',
    );
    expect(
      items.some(
        (item) =>
          item.kind === 'journal' &&
          item.record.type === 'completed' &&
          item.record.messageId === messageID,
      ),
    ).toBe(true);

    await waitUntil(() => relays.some((relay) => relay.turn_message_id === messageID), 2_500);
    expect(relays.find((relay) => relay.turn_message_id === messageID)).toMatchObject({
      status: 'error',
      turn_message_id: messageID,
      opencode_session_id: sessionID,
    });

    const asyncRetry = await request(second, `/session/${sessionID}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'execute once' }] }),
    });
    expect(asyncRetry.status).toBe(204);
    const blockingRetry = await request(second, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageID, parts: [{ type: 'text', text: 'execute once' }] }),
    });
    expect(blockingRetry.status).toBe(200);
    expect(((await blockingRetry.json()) as { info: AssistantMessage }).info.error?.name).toBe(
      'MessageAbortedError',
    );
  });
});

describe('prompt system durability', () => {
  test('queued systems stay isolated and retries preserve the accepted system after replacement', async () => {
    const reached = deferred();
    const released = deferred();
    const envUrl = await listen(
      createServer(async (_req, res) => {
        reached.resolve();
        await released.promise;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, value: { stdout: 'done', stderr: '', exitCode: 0 } }));
      }),
    );
    const items: SessionLogItem[] = [];
    const config = {
      port: 0,
      envUrl,
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Compiled instructions.',
      modelMode: 'faux' as const,
      sessionId: 'queued-system',
      kortixToken: 'runtime-token',
      storeUrl: await sharedStore(items),
    };
    const worker = await startWorker(config);
    workers.push(worker);
    requireValue(worker.faux, 'faux model').setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'hold' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('first done'),
      fauxAssistantMessage('second done'),
    ]);
    const base = worker.agent.state.systemPrompt;
    const seen: string[] = [];
    const stream = worker.agent.streamFunction;
    worker.agent.streamFunction = (model, context, options) => {
      seen.push(context.systemPrompt ?? '');
      return stream(model, context, options);
    };
    const sessionID = await rootId(worker);
    const firstID = mintWireMessageId({ nowMs: Date.now() }).id;
    const secondID = mintWireMessageId({ nowMs: Date.now() + 1_000 }).id;
    const firstBody = {
      messageID: firstID,
      system: 'Convention A.',
      parts: [{ type: 'text', text: 'first' }],
    };
    const secondBody = {
      messageID: secondID,
      system: 'Convention B.',
      parts: [{ type: 'text', text: 'second' }],
    };
    const send = (target: typeof worker, body: unknown, endpoint = 'prompt_async') =>
      request(target, `/session/${sessionID}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      expect((await send(worker, firstBody)).status).toBe(204);
      await reached.promise;
      expect((await send(worker, secondBody)).status).toBe(204);
      expect((await send(worker, secondBody)).status).toBe(204);
      expect(
        (await send(worker, { ...secondBody, system: 'Conflicting convention.' })).status,
      ).toBe(409);
      expect(worker.agent.state.systemPrompt).toBe(`${base}\nConvention A.`);
    } finally {
      released.resolve();
    }
    expect((await send(worker, secondBody, 'message')).status).toBe(200);
    expect(seen).toEqual([
      `${base}\nConvention A.`,
      `${base}\nConvention A.`,
      `${base}\nConvention B.`,
    ]);
    expect(worker.agent.state.systemPrompt).toBe(base);
    worker.server.closeAllConnections();
    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    const restored = await startWorker(config);
    workers.push(restored);
    const replay = await send(restored, firstBody, 'message');
    expect(replay.status).toBe(200);
    expect(
      (await send(restored, { ...firstBody, system: 'Changed after replacement.' })).status,
    ).toBe(409);
    const messages = (await (await request(restored, `/session/${sessionID}/message`)).json()) as {
      info: { role: string; system?: string };
    }[];
    expect(
      messages
        .filter((message) => message.info.role === 'user')
        .map((message) => message.info.system),
    ).toEqual(['Convention A.', 'Convention B.']);
    expect(restored.agent.state.systemPrompt).toBe(base);
  });

  test('accepted-only replay applies its saved system before the first provider request', async () => {
    const items: SessionLogItem[] = [];
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      envTransport: 'fetch' as const,
      systemPrompt: 'Compiled instructions.',
      modelMode: 'faux' as const,
      sessionId: 'replayed-system',
      kortixToken: 'runtime-token',
      storeUrl: await sharedStore(items),
    };
    const first = await startWorker(config);
    workers.push(first);
    await prime(first, ['record a valid admission']);
    const sessionID = await rootId(first);
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      system: 'Saved convention.',
      parts: [{ type: 'text', text: 'replay me' }],
    };
    const response = await request(first, `/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    first.server.closeAllConnections();
    await first.close();
    workers.splice(workers.indexOf(first), 1);
    const accepted = requireValue(
      items.find((item) => item.kind === 'journal' && item.record.type === 'accepted'),
      'accepted record',
    );
    const systemBeforeReplay = first.agent.state.systemPrompt;
    const pending: SessionLogItem[] = [structuredClone(accepted)];
    const seen: string[] = [];
    const provider = await listen(
      createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const payload = JSON.parse(raw) as { messages: { role: string; content: string }[] };
        seen.push(
          payload.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n'),
        );
        res
          .writeHead(200, { 'content-type': 'text/event-stream' })
          .end(
            'data: ' +
              JSON.stringify({
                id: 'replay',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'openai/gpt-4.1',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'Replayed.' },
                    finish_reason: 'stop',
                  },
                ],
              }) +
              '\n\ndata: [DONE]\n\n',
          );
      }),
    );
    const replayed = await startWorker({
      ...config,
      storeUrl: await sharedStore(pending),
      modelMode: 'real',
      providerId: 'openrouter',
      modelId: 'openai/gpt-4.1',
      gatewayUrl: provider + '/v1',
      apiKey: 'fixture-provider-token',
    });
    workers.push(replayed);
    await waitUntil(() =>
      pending.some((item) => item.kind === 'journal' && item.record.type === 'completed'),
    );
    expect(seen).toEqual([`${systemBeforeReplay}\nSaved convention.`]);
    await waitUntil(() => replayed.agent.state.systemPrompt === systemBeforeReplay);
    const messages = (await (await request(replayed, `/session/${sessionID}/message`)).json()) as {
      info: { id: string; system?: string };
    }[];
    expect(messages.find((message) => message.info.id === body.messageID)?.info.system).toBe(
      'Saved convention.',
    );
  });
});

describe('context-only prompts', () => {
  async function fixture(
    items: SessionLogItem[] = [],
    options: {
      beforeProvider?: () => Promise<void>;
      providerStatus?: number;
      rejectAppend?: (item: SessionLogItem) => number | undefined;
    } = {},
  ) {
    const requests: any[] = [];
    const provider = await listen(
      createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        requests.push(JSON.parse(raw));
        await options.beforeProvider?.();
        if (options.providerStatus) {
          res
            .writeHead(options.providerStatus, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: { message: 'Provider rejected the prompt.' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
          'data: ' +
            JSON.stringify({
              id: 'context-response',
              model: 'openai/gpt-4.1',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Replied.' },
                  finish_reason: 'stop',
                },
              ],
            }) +
            '\n\ndata: [DONE]\n\n',
        );
      }),
    );
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      systemPrompt: 'Compiled instructions.',
      modelMode: 'real' as const,
      providerId: 'openrouter',
      modelId: 'openai/gpt-4.1',
      gatewayUrl: provider + '/v1',
      apiKey: 'fixture-provider-token',
      kortixToken: 'runtime-token',
      sessionId: 'context-only',
      storeUrl: await sharedStore(items, options.rejectAppend),
      turnOwnerLeaseMs: 200,
      turnOwnerHeartbeatMs: 20,
    };
    const worker = await startWorker(config);
    workers.push(worker);
    const sessionID = await rootId(worker);
    const send = (target: typeof worker, body: unknown, endpoint = 'message') =>
      request(target, `/session/${sessionID}/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    return { worker, config, requests, sessionID, send };
  }

  test('stores and retries a user message without a model call and includes it in the next prompt after replacement', async () => {
    const { worker, config, requests, sessionID, send } = await fixture();
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      noReply: true,
      system: 'This system applies only to this context-only input.',
      parts: [{ type: 'text', text: 'The fixture convention is violet.' }],
    };
    const response = await send(worker, body);
    expect(response.status).toBe(200);
    const saved = (await response.json()) as any;
    expect(saved.info.role).toBe('user');
    expect(saved.info.id).toBe(body.messageID);
    expect(saved.parts.map((part: any) => part.text)).toEqual([
      'The fixture convention is violet.',
    ]);
    expect(requests).toEqual([]);
    const repeated = await send(worker, body);
    expect(repeated.status).toBe(200);
    expect(repeated.headers.get('x-kortix-prompt-completed')).toBe('idle');
    expect(repeated.headers.get('x-kortix-prompt-message-id')).toBe(body.messageID);
    expect(await repeated.json()).toEqual(saved);
    expect((await send(worker, { ...body, noReply: false })).status).toBe(409);
    worker.server.closeAllConnections();
    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    const restored = await startWorker(config);
    workers.push(restored);
    expect(requests).toEqual([]);
    const restoredMessages = (await (
      await request(restored, `/session/${sessionID}/message`)
    ).json()) as any[];
    expect(restoredMessages).toEqual([saved]);
    const next = await send(restored, {
      parts: [{ type: 'text', text: 'Apply the convention.' }],
    });
    expect(next.status).toBe(200);
    expect(((await next.json()) as any).info.role).toBe('assistant');
    expect(requests).toHaveLength(1);
    expect(
      requests[0].messages.filter((m: any) => m.role === 'user').map((m: any) => m.content),
    ).toEqual([
      [{ type: 'text', text: 'The fixture convention is violet.' }],
      [{ type: 'text', text: 'Apply the convention.' }],
    ]);
    expect(requests[0].messages.find((m: any) => m.role === 'system').content).not.toContain(
      body.system,
    );
  });

  test.each(['accepted', 'started', 'persisted'] as const)(
    'recovers a %s context-only prompt without fabricating an interruption or calling the model',
    async (phase) => {
      const items: SessionLogItem[] = [];
      const { worker, config, requests, sessionID, send } = await fixture(items);
      const body = {
        messageID: mintWireMessageId({ nowMs: Date.now() }).id,
        noReply: true,
        parts: [{ type: 'text', text: 'Saved context.' }],
      };
      expect((await send(worker, body)).status).toBe(200);
      worker.server.closeAllConnections();
      await worker.close();
      workers.splice(workers.indexOf(worker), 1);
      const accepted = requireValue(
        items.find((item) => item.kind === 'journal' && item.record.type === 'accepted'),
        'accepted record',
      );
      const started = requireValue(
        items.find((item) => item.kind === 'journal' && item.record.type === 'started'),
        'started record',
      );
      const userEntry = requireValue(
        items.find((item) => item.kind === 'entry' && item.entry.type === 'message'),
        'user entry',
      );
      const boundary = phase === 'accepted' ? accepted : phase === 'started' ? started : userEntry;
      const seed = structuredClone(items.slice(0, items.indexOf(boundary) + 1));
      const restored = await startWorker({
        ...config,
        storeUrl: await sharedStore(seed),
      });
      workers.push(restored);
      const retry = await send(restored, body);
      expect(retry.status).toBe(200);
      expect(((await retry.json()) as any).info.role).toBe('user');
      const messages = (await (
        await request(restored, `/session/${sessionID}/message`)
      ).json()) as any[];
      expect(messages).toHaveLength(1);
      expect(messages[0].info.id).toBe(body.messageID);
      expect(requests).toEqual([]);
      expect(
        restored.agent.state.messages.filter(
          (m: any) => m.role === 'user' && m.kortixWireMessageId === body.messageID,
        ),
      ).toHaveLength(1);
    },
  );

  test('acknowledges async context after admission and publishes one saved user message', async () => {
    const items: SessionLogItem[] = [];
    const { worker, requests, sessionID, send } = await fixture(items);
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      noReply: true,
      parts: [{ type: 'text', text: 'Async context.' }],
    };
    const event = waitForGlobalEvent(worker, 'message.updated', body.messageID);
    const response = await send(worker, body, 'prompt_async');
    expect(response.status).toBe(204);
    expect(items.some((item) => item.kind === 'journal' && item.record.type === 'accepted')).toBe(
      true,
    );
    expect(await event).toContain(body.messageID);
    await waitUntil(() =>
      items.some((item) => item.kind === 'journal' && item.record.type === 'completed'),
    );
    const asyncRetry = await send(worker, body, 'prompt_async');
    expect(asyncRetry.status).toBe(204);
    expect(asyncRetry.headers.get('x-kortix-prompt-completed')).toBe('idle');
    expect(asyncRetry.headers.get('x-kortix-prompt-message-id')).toBe(body.messageID);
    await waitUntil(() =>
      items.some((item) => item.kind === 'journal' && item.record.type === 'completed'),
    );
    const saved = (await (await request(worker, `/session/${sessionID}/message`)).json()) as any[];
    expect(saved).toHaveLength(1);
    expect(saved[0].info.id).toBe(body.messageID);
    expect(requests).toHaveLength(0);
  });

  test('queues context behind the active model turn and includes it once in the following prompt', async () => {
    const items: SessionLogItem[] = [];
    const hold = deferred();
    const { worker, requests, send } = await fixture(items, {
      beforeProvider: () => hold.promise,
    });
    expect(
      (await send(worker, { parts: [{ type: 'text', text: 'First prompt.' }] }, 'prompt_async'))
        .status,
    ).toBe(204);
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() + 1_000 }).id,
      noReply: true,
      parts: [{ type: 'text', text: 'Queued convention.' }],
    };
    try {
      await waitUntil(() => requests.length === 1);
      expect((await send(worker, body, 'prompt_async')).status).toBe(204);
      expect(
        worker.agent.state.messages.some((m: any) => m.kortixWireMessageId === body.messageID),
      ).toBe(false);
    } finally {
      hold.resolve();
    }
    expect((await send(worker, body)).status).toBe(200);
    expect(requests).toHaveLength(1);
    expect(
      (
        await send(worker, {
          parts: [{ type: 'text', text: 'Use the convention.' }],
        })
      ).status,
    ).toBe(200);
    expect(requests).toHaveLength(2);
    expect(
      requests[1].messages.filter((m: any) => m.role === 'user').map((m: any) => m.content),
    ).toEqual(
      ['First prompt.', 'Queued convention.', 'Use the convention.'].map((text) => [
        { type: 'text', text },
      ]),
    );
  });

  test('treats false and omitted noReply as the same normal model prompt', async () => {
    const { worker, requests, send } = await fixture();
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      parts: [{ type: 'text', text: 'Normal reply.' }],
    };
    const response = await send(worker, { ...body, noReply: false });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-kortix-prompt-completed')).toBe('idle');
    expect(response.headers.get('x-kortix-prompt-message-id')).toBe(body.messageID);
    const answer = (await response.json()) as any;
    expect(answer.info.role).toBe('assistant');
    const retry = await send(worker, body);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(answer);
    expect(requests).toHaveLength(1);
  });

  test('does not acknowledge failed context persistence and recovers it without a model call', async () => {
    const items: SessionLogItem[] = [];
    let reject = true;
    const { worker, config, requests, sessionID, send } = await fixture(items, {
      rejectAppend: (item) =>
        reject && item.kind === 'entry' && item.entry.type === 'message' ? 403 : undefined,
    });
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      noReply: true,
      parts: [{ type: 'text', text: 'Recover this context.' }],
    };
    expect((await send(worker, body)).status).toBe(503);
    expect(items.some((item) => item.kind === 'journal' && item.record.type === 'completed')).toBe(
      false,
    );
    expect(requests).toHaveLength(0);
    worker.server.closeAllConnections();
    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    reject = false;
    const restored = await startWorker(config);
    workers.push(restored);
    const retry = await send(restored, body);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as any).info.role).toBe('user');
    const messages = (await (
      await request(restored, `/session/${sessionID}/message`)
    ).json()) as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].info.id).toBe(body.messageID);
    expect(requests).toHaveLength(0);
  });

  test('returns an error completion receipt for a durable provider failure and its retry', async () => {
    const { worker, send, requests } = await fixture([], { providerStatus: 400 });
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      parts: [{ type: 'text', text: 'Fail this prompt.' }],
    };
    const failed = await send(worker, body);
    expect(failed.status).toBe(200);
    expect(failed.headers.get('x-kortix-prompt-completed')).toBe('error');
    expect(failed.headers.get('x-kortix-prompt-message-id')).toBe(body.messageID);
    const answer = (await failed.json()) as any;
    expect(answer.info.error).toBeDefined();
    const retry = await send(worker, body, 'prompt_async');
    expect(retry.status).toBe(204);
    expect(retry.headers.get('x-kortix-prompt-completed')).toBe('error');
    expect(requests).toHaveLength(1);
  });

  test('does not acknowledge a cancelled context retry as active work', async () => {
    const hold = deferred();
    const { worker, send, sessionID } = await fixture([], { beforeProvider: () => hold.promise });
    const first = await send(
      worker,
      { parts: [{ type: 'text', text: 'Hold this model response.' }] },
      'prompt_async',
    );
    expect(first.status).toBe(204);
    expect(first.headers.get('x-kortix-prompt-completed')).toBeNull();
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() + 1_000 }).id,
      noReply: true,
      parts: [{ type: 'text', text: 'Cancel this context.' }],
    };
    try {
      expect((await send(worker, body, 'prompt_async')).status).toBe(204);
      expect(
        (
          await request(worker, `/session/${sessionID}/message/${body.messageID}`, {
            method: 'DELETE',
          })
        ).status,
      ).toBe(200);
      const retried = await send(worker, body, 'prompt_async');
      expect(retried.status).toBe(409);
      expect(await retried.json()).toEqual({ error: 'message was cancelled before execution' });
    } finally {
      hold.resolve();
    }
  });
});

describe("prompt tool controls", () => {
  async function fixture(
    options: {
      items?: SessionLogItem[];
      beforeResponse?: (body: any, index: number) => Promise<void>;
      delta?: (index: number) => Record<string, unknown>;
      providerStatus?: number;
    } = {},
  ) {
    const requests: any[] = [];
    const provider = await listen(
      createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests.push(body);
        const index = requests.length - 1;
        await options.beforeResponse?.(body, index);
        if (options.providerStatus) {
          res
            .writeHead(options.providerStatus, {
              "content-type": "application/json",
            })
            .end(
              JSON.stringify({
                error: { message: "Fixture provider failure." },
              }),
            );
          return;
        }
        const delta = options.delta?.(index) ?? {
          role: "assistant",
          content: "CONTROL_PROOF",
        };
        res.writeHead(200, { "content-type": "text/event-stream" }).end(
          "data: " +
            JSON.stringify({
              id: `controls-${index}`,
              model: "openai/gpt-4.1",
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: delta.tool_calls ? "tool_calls" : "stop",
                },
              ],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
      }),
    );
    const config = {
      port: 0,
      envUrl: "http://127.0.0.1:1",
      envUrlExplicit: true,
      envCwd: "/workspace",
      systemPrompt: "Follow the user.",
      modelMode: "real" as const,
      providerId: "openrouter",
      modelId: "openai/gpt-4.1",
      gatewayUrl: provider + "/v1",
      apiKey: "provider-fixture",
      kortixToken: "runtime-token",
      sessionId: "tool-controls",
      storeUrl: await sharedStore(options.items ?? []),
      turnOwnerLeaseMs: 200,
      turnOwnerHeartbeatMs: 20,
    };
    const worker = await startWorker(config);
    workers.push(worker);
    const sessionID = await rootId(worker);
    const send = (
      target: typeof worker,
      body: Record<string, unknown>,
      endpoint = "message",
    ) =>
      request(target, `/session/${sessionID}/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ type: "text", text: "Verify tool controls." }],
          ...body,
        }),
      });
    const names = (index: number) =>
      (requests[index]?.tools ?? []).map((tool: any) => tool.function.name);
    return { worker, config, requests, send, names, sessionID };
  }

  test("context-only controls persist across worker replacement and exact retries cannot reset newer controls", async () => {
    const { worker, config, requests, send, names, sessionID } =
      await fixture();
    const body = {
      messageID: mintWireMessageId({ nowMs: Date.now() }).id,
      noReply: true,
      tools: { edit: false, bash: false },
    };
    const response = await send(worker, body);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).info.tools).toEqual(body.tools);
    expect(
      ((await (await request(worker, `/session/${sessionID}`)).json()) as any)
        .permission,
    ).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ]);
    expect(requests).toHaveLength(0);
    expect((await send(worker, {})).status).toBe(200);
    expect(names(0)).not.toContain("bash");
    expect(names(0)).not.toContain("write");
    expect(names(0)).not.toContain("edit");
    expect(names(0)).toContain("read");
    worker.server.closeAllConnections();
    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
    const replacement = await startWorker(config);
    workers.push(replacement);
    expect((await send(replacement, { tools: {} })).status).toBe(200);
    expect(names(1)).toEqual(names(0));
    expect(
      (
        (await (
          await request(replacement, `/session/${sessionID}`)
        ).json()) as any
      ).permission,
    ).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    ]);
    const messages = (await (
      await request(replacement, `/session/${sessionID}/message`)
    ).json()) as any[];
    expect(
      messages.find((message) => message.info.id === body.messageID).info.tools,
    ).toEqual(body.tools);
    expect(
      (await send(replacement, { tools: { todowrite: false } })).status,
    ).toBe(200);
    expect(names(2)).toContain("bash");
    expect(names(2)).toContain("write");
    expect(names(2)).not.toContain("todowrite");
    expect((await send(replacement, body)).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(
      (await send(replacement, { ...body, tools: { bash: true } })).status,
    ).toBe(409);
    expect((await send(replacement, {})).status).toBe(200);
    expect(names(3)).toEqual(names(2));
    expect(replacement.env.calls).toHaveLength(0);
  });

  test("wildcard rule order is part of retry identity", async () => {
    const { worker, send, names } = await fixture();
    const messageID = mintWireMessageId({ nowMs: Date.now() }).id;
    expect(
      (await send(worker, { messageID, tools: { "*": false, question: true } }))
        .status,
    ).toBe(200);
    expect(names(0)).toEqual(["question"]);
    expect(
      (await send(worker, { messageID, tools: { question: true, "*": false } }))
        .status,
    ).toBe(409);
    expect((await send(worker, {})).status).toBe(200);
    expect(names(1)).toEqual(["question"]);
  });

  test("queued and cancelled tool controls cannot change the active model request", async () => {
    const hold = deferred();
    const { worker, send, names, requests, sessionID } = await fixture({
      beforeResponse: async (_body, index) => {
        if (index === 0) await hold.promise;
      },
    });
    try {
      const first = send(worker, { tools: { bash: false } });
      await waitUntil(() => requests.length === 1);
      const queued = mintWireMessageId({ nowMs: Date.now() }).id;
      expect(
        (
          await send(
            worker,
            { messageID: queued, tools: { read: false } },
            "prompt_async",
          )
        ).status,
      ).toBe(204);
      const cancelled = mintWireMessageId({ nowMs: Date.now() + 1 }).id;
      expect(
        (
          await send(
            worker,
            { messageID: cancelled, tools: { "*": false } },
            "prompt_async",
          )
        ).status,
      ).toBe(204);
      expect(
        (
          await request(worker, `/session/${sessionID}/message/${cancelled}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(200);
      expect(worker.agent.state.tools.map((tool) => tool.name)).not.toContain(
        "bash",
      );
      expect(worker.agent.state.tools.map((tool) => tool.name)).toContain(
        "read",
      );
      hold.resolve();
      expect((await first).status).toBe(200);
      await waitUntil(() => requests.length === 2);
      expect((await send(worker, {})).status).toBe(200);
      expect(names(0)).not.toContain("bash");
      expect(names(1)).toContain("bash");
      expect(names(1)).not.toContain("read");
      expect(names(2)).toEqual(names(1));
    } finally {
      hold.resolve();
    }
  });

  test("a provider cannot execute a tool removed by prompt controls", async () => {
    const { worker, send, names, requests } = await fixture({
      delta: (index) =>
        index === 0
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "blocked-todo",
                  type: "function",
                  function: {
                    name: "todowrite",
                    arguments: JSON.stringify({
                      todos: [
                        {
                          content: "Must not execute",
                          status: "pending",
                          priority: "high",
                        },
                      ],
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: "The tool was unavailable." },
    });
    expect((await send(worker, { tools: { todowrite: false } })).status).toBe(
      200,
    );
    expect(names(0)).not.toContain("todowrite");
    expect(requests).toHaveLength(2);
    const result = requests[1].messages.findLast(
      (message: any) => message.role === "tool",
    );
    expect(result.content).toContain("not found");
    const todo = await request(worker, `/session/${await rootId(worker)}/todo`);
    expect(await todo.json()).toEqual([]);
    expect(worker.env.calls).toHaveLength(0);
  });

  test("provider failure preserves started controls for the next worker", async () => {
    const items: SessionLogItem[] = [];
    const failed = await fixture({ items, providerStatus: 400 });
    const response = await failed.send(failed.worker, {
      tools: { bash: false },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).info.error).toBeDefined();
    failed.worker.server.closeAllConnections();
    await failed.worker.close();
    workers.splice(workers.indexOf(failed.worker), 1);
    const next = await fixture({ items });
    expect((await next.send(next.worker, {})).status).toBe(200);
    expect(next.names(0)).not.toContain("bash");
  });
});

describe('durable context compaction', () => {
  async function fixture(fullContext = false, turnOwnerLeaseMs = 100) {
    const items: SessionLogItem[] = [];
    const config = {
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      systemPrompt: 'Follow the user.',
      turnOwnerLeaseMs,
      turnOwnerHeartbeatMs: 20,
      modelMode: 'faux' as const,
      sessionId: `compact-${crypto.randomUUID()}`,
      kortixToken: 'runtime-token',
      storeUrl: await sharedStore(items),
    };
    const worker = await startWorker(config);
    workers.push(worker);
    const sessionID = await rootId(worker);
    const post = (target: typeof worker, route: string, body: unknown) => request(target,
      `/session/${sessionID}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const compactBody = { providerID: worker.agent.state.model!.provider, modelID: worker.agent.state.model!.id };
    const history = async (target = worker) => (await request(target, `/session/${sessionID}/message`)).json() as Promise<any[]>;
    worker.faux!.setResponses([fauxAssistantMessage('OLD_ASSISTANT_DETAIL')]);
    expect((await post(worker, 'message', { parts: [{ type: 'text', text: 'OLD_USER_DETAIL: remember the launch code cobalt.' }] })).status).toBe(200);
    if (fullContext) {
      for (let index = 0; index < 4; index++) {
        expect((await post(worker, 'message', { noReply: true, parts: [{ type: 'text', text: `ARCHIVE_${index}: ${'data '.repeat(24000)}` }] })).status).toBe(200);
      }
    }
    return { items, config, worker, sessionID, post, compactBody, history };
  }

  async function toolRoundFixture() {
    const result = await fixture(false, 1000);
    result.worker.agent.state.model!.contextWindow = 4096;
    let calls = 0;
    result.worker.agent.state.tools.push({
      name: 'large_result',
      label: 'Large result',
      description: 'Read a large result.',
      parameters: { type: 'object', properties: {} } as any,
      execute: async () => {
        calls++;
        return { content: [{ type: 'text', text: `ROUND_OUTPUT_${calls}: ${'data '.repeat(3000)}` }], details: {} };
      },
    });
    const toolCall = () => fauxAssistantMessage([fauxToolCall('large_result', {})], { stopReason: 'toolUse' });
    return { ...result, toolCall, calls: () => calls };
  }

  test('compacts between tool rounds without duplicating tools or removing the visible transcript', async () => {
    const { worker, config, items, post, history, toolCall, calls } = await toolRoundFixture();
    const before = await history();
    const contexts: string[] = [];
    worker.faux!.setResponses([
      toolCall(),
      ctx => {
        expect(JSON.stringify(ctx.messages).includes('ROUND_OUTPUT_1')).toBe(true);
        return fauxAssistantMessage('ROUND_SUMMARY_ONE: keep cobalt and the tool result.');
      },
      ctx => { contexts.push(JSON.stringify(ctx.messages)); return toolCall(); },
      ctx => {
        const text = JSON.stringify(ctx.messages);
        expect(text.includes('ROUND_OUTPUT_2')).toBe(true);
        expect(text.includes('ROUND_SUMMARY_ONE')).toBe(true);
        return fauxAssistantMessage('ROUND_SUMMARY_TWO: both tool calls completed.');
      },
      ctx => { contexts.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('both reads completed'); },
    ]);
    const input = { messageID: mintWireMessageId({ nowMs: Date.now() }).id, parts: [{ type: 'text', text: 'Read twice and report.' }] };
    expect((await post(worker, 'message', input)).status).toBe(200);
    expect(calls()).toBe(2);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain('ROUND_SUMMARY_ONE');
    expect(contexts[1]).toContain('ROUND_SUMMARY_TWO');
    expect(contexts.every(context => !context.includes('ROUND_OUTPUT_'))).toBe(true);
    expect(items.filter((i: any) => i.kind === 'entry' && i.entry.type === 'compaction')).toHaveLength(2);
    const after = await history();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.filter(m => m.parts.some((p: any) => p.type === 'compaction' && p.auto))).toHaveLength(2);
    expect(after.flatMap(m => m.parts).filter((p: any) => p.type === 'tool' && p.tool === 'large_result')).toHaveLength(2);
    expect(after.at(-1).info.parentID).toBe(input.messageID);
    expect(after.at(-1).info.error).toBeUndefined();
    const count = worker.faux!.state.callCount;
    await post(worker, 'message', input);
    expect(worker.faux!.state.callCount).toBe(count);
    await worker.close();
    const replacement = await startWorker(config);
    workers.push(replacement);
    expect(await history(replacement)).toEqual(after);
    replacement.faux!.setResponses([ctx => {
      expect(JSON.stringify(ctx.messages)).toContain('ROUND_SUMMARY_TWO');
      expect(JSON.stringify(ctx.messages)).not.toContain('ROUND_OUTPUT_');
      return fauxAssistantMessage('both reads remain completed');
    }]);
    expect((await post(replacement, 'message', { parts: [{ type: 'text', text: 'Recall the reads.' }] })).status).toBe(200);
  });

  test('replacement preserves a summary committed between tool rounds and never replays completed tools', async () => {
    const { worker, config, post, history, items, toolCall, calls } = await toolRoundFixture();
    let atCrash: SessionLogItem[] = [];
    worker.faux!.setResponses([
      toolCall(),
      fauxAssistantMessage('ROUND_CRASH_SUMMARY: the read completed, remember cobalt.'),
      () => { atCrash = structuredClone(items); return fauxAssistantMessage('finished before replacement'); },
    ]);
    const input = { messageID: mintWireMessageId({ nowMs: Date.now() }).id, parts: [{ type: 'text', text: 'Read and report after summarizing.' }] };
    expect((await post(worker, 'message', input)).status).toBe(200);
    expect(calls()).toBe(1);
    const beforeCrash = (await history()).slice(0, -1);
    expect(atCrash.filter((i: any) => i.kind === 'entry' && i.entry.type === 'compaction')).toHaveLength(1);
    await worker.close();
    const replacement = await startWorker({ ...config, storeUrl: await sharedStore(atCrash) });
    workers.push(replacement);
    const restored = await history(replacement);
    expect(restored.slice(0, beforeCrash.length)).toEqual(beforeCrash);
    expect(restored.at(-1).info.parentID).toBe(input.messageID);
    expect(restored.at(-1).info.error).toBeDefined();
    await post(replacement, 'message', input);
    expect(replacement.faux!.state.callCount).toBe(0);
    replacement.faux!.setResponses([ctx => {
      const text = JSON.stringify(ctx.messages);
      expect(text.includes('ROUND_CRASH_SUMMARY')).toBe(true);
      expect(text.includes('ROUND_OUTPUT_')).toBe(false);
      return fauxAssistantMessage('the read remains completed');
    }]);
    await post(replacement, 'message', { parts: [{ type: 'text', text: 'Recall the completed read.' }] });
    expect((await history(replacement)).at(-1).info.error).toBeUndefined();
  });

  test('Stop during tool-round compaction preserves the completed tool and prevents another model round', async () => {
    const { worker, items, post, sessionID, history, toolCall, calls } = await toolRoundFixture();
    const entered = deferred();
    worker.faux!.setResponses([toolCall(), async (_ctx, options) => {
      entered.resolve();
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'summary stopped' });
    }]);
    const input = { messageID: mintWireMessageId({ nowMs: Date.now() }).id, parts: [{ type: 'text', text: 'Read then wait.' }] };
    const pending = post(worker, 'message', input);
    await entered.promise;
    expect((await history()).some(m => m.info.summary === true && !m.info.time.completed)).toBe(true);
    expect((await request(worker, `/session/${sessionID}/abort`, { method: 'POST' })).status).toBe(200);
    await pending;
    expect(calls()).toBe(1);
    expect(worker.faux!.state.callCount).toBe(3);
    expect(items.filter((i: any) => i.kind === 'entry' && i.entry.type === 'compaction')).toHaveLength(0);
    const after = await history();
    expect(after.at(-1).info.parentID).toBe(input.messageID);
    expect(after.at(-1).info.error).toBeDefined();
    expect(after.flatMap(m => m.parts).find((p: any) => p.tool === 'large_result').state.output).toContain('ROUND_OUTPUT_1');
  });

  test('a failed tool-round summary retains the completed tool without executing another model round', async () => {
    const { worker, post, history, toolCall, calls } = await toolRoundFixture();
    worker.faux!.setResponses([
      toolCall(),
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'summary service unavailable' }),
    ]);
    const input = { messageID: mintWireMessageId({ nowMs: Date.now() }).id, parts: [{ type: 'text', text: 'Read and summarize.' }] };
    await post(worker, 'message', input);
    expect(calls()).toBe(1);
    expect(worker.faux!.state.callCount).toBe(3);
    const after = await history();
    expect(after.at(-1).info.parentID).toBe(input.messageID);
    expect(after.at(-1).info.error).toBeDefined();
    expect(after.flatMap(m => m.parts).find((p: any) => p.tool === 'large_result').state.output).toContain('ROUND_OUTPUT_1');
  });

  test("automatically compacts a full context before the accepted prompt and preserves replay after replacement", async () => {
    const { items, config, worker, post, history } = await fixture(true);
    const before = await history();
    let promptContext = "";
    worker.faux!.setResponses([
      fauxAssistantMessage("AUTOMATIC_SUMMARY: launch code cobalt."),
      (ctx) => {
        promptContext = JSON.stringify(ctx.messages);
        return fauxAssistantMessage("cobalt after automatic compaction");
      },
    ]);
    const input = {
      messageID: mintWireMessageId({ nowMs: Date.now() + 1000 }).id,
      parts: [{ type: "text", text: "Recall the launch code." }],
    };
    expect((await post(worker, "message", input)).status).toBe(200);
    expect(promptContext).toContain("AUTOMATIC_SUMMARY");
    expect(promptContext).toContain("Recall the launch code.");
    expect(promptContext).not.toContain("OLD_USER_DETAIL");
    const after = await history();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(
      after.filter((m) =>
        m.parts.some((p: any) => p.type === "compaction" && p.auto === true),
      ),
    ).toHaveLength(1);
    expect(after.at(-1).info.parentID).toBe(input.messageID);
    expect(worker.env.calls).toHaveLength(0);
    const count = worker.faux!.state.callCount;
    expect((await post(worker, "message", input)).status).toBe(200);
    expect(worker.faux!.state.callCount).toBe(count);
    expect(
      items.filter(
        (i: any) => i.kind === "entry" && i.entry.type === "compaction",
      ),
    ).toHaveLength(1);
    await worker.close();
    const replacement = await startWorker(config);
    workers.push(replacement);
    expect(await history(replacement)).toEqual(after);
    replacement.faux!.setResponses([
      (ctx) => {
        promptContext = JSON.stringify(ctx.messages);
        return fauxAssistantMessage("cobalt again");
      },
    ]);
    expect(
      (
        await post(replacement, "message", {
          parts: [{ type: "text", text: "Recall again." }],
        })
      ).status,
    ).toBe(200);
    expect(promptContext).toContain("AUTOMATIC_SUMMARY");
    expect(promptContext).not.toContain("OLD_USER_DETAIL");
  });

  test('replacement keeps an automatic summary committed before the accepted prompt starts', async () => {
    const { items, config, worker, post, history } = await fixture(true);
    const before = await history();
    let atCrash: SessionLogItem[] = [];
    worker.faux!.setResponses([
      fauxAssistantMessage('AUTOMATIC_CRASH_SUMMARY: cobalt.'),
      () => { atCrash = structuredClone(items); return fauxAssistantMessage('original completed'); },
    ]);
    const input = { messageID: mintWireMessageId({ nowMs: Date.now() + 1000 }).id, parts: [{ type: 'text', text: 'Continue after summarizing.' }] };
    expect((await post(worker, 'message', input)).status).toBe(200);
    expect(atCrash.filter((i: any) => i.kind === 'entry' && i.entry.type === 'compaction')).toHaveLength(1);
    await worker.close();
    const replacement = await startWorker({ ...config, storeUrl: await sharedStore(atCrash) });
    workers.push(replacement);
    const restored = await history(replacement);
    expect(restored.slice(0, before.length)).toEqual(before);
    expect(restored.some(m => m.parts.some((p: any) => p.text?.includes('AUTOMATIC_CRASH_SUMMARY')))).toBe(true);
    expect(restored.at(-1).info.parentID).toBe(input.messageID);
    expect(restored.at(-1).info.error).toBeDefined();
    expect(replacement.faux!.state.callCount).toBe(0);
    let nextContext = '';
    replacement.faux!.setResponses([ctx => { nextContext = JSON.stringify(ctx.messages); return fauxAssistantMessage('cobalt'); }]);
    expect((await post(replacement, 'message', { parts: [{ type: 'text', text: 'Recall after replacement.' }] })).status).toBe(200);
    expect(nextContext).toContain('AUTOMATIC_CRASH_SUMMARY');
    expect(nextContext).not.toContain('OLD_USER_DETAIL');
  });

  test('a failed automatic summary leaves the accepted prompt unexecuted and permits a later retry', async () => {
    const { worker, post, history } = await fixture(true);
    worker.faux!.setResponses([fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'summary provider unavailable' })]);
    const input = { messageID: mintWireMessageId({ nowMs: Date.now() + 1000 }).id, parts: [{ type: 'text', text: 'Wait for compaction.' }] };
    await post(worker, 'message', input);
    expect(worker.faux!.state.callCount).toBe(2);
    expect((await history()).find(m => m.info.parentID === input.messageID)?.info.error).toBeDefined();
    worker.faux!.setResponses([
      fauxAssistantMessage('RECOVERED_AUTOMATIC_SUMMARY'),
      fauxAssistantMessage('continued'),
    ]);
    expect((await post(worker, 'message', { parts: [{ type: 'text', text: 'Retry now.' }] })).status).toBe(200);
    expect((await history()).at(-1).info.error).toBeUndefined();
  });

  test("Stop during automatic compaction cancels the accepted prompt without running it", async () => {
    const { worker, items, post, sessionID, history } = await fixture(true);
    const entered = deferred();
    worker.faux!.setResponses([
      async (_ctx, options) => {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage([], {
          stopReason: "aborted",
          errorMessage: "stopped",
        });
      },
    ]);
    const input = {
      messageID: mintWireMessageId({ nowMs: Date.now() + 1000 }).id,
      parts: [{ type: "text", text: "Do not run after Stop." }],
    };
    const pending = post(worker, "message", input);
    await entered.promise;
    expect(
      (await history()).some(
        (m) => m.info.summary === true && !m.info.time.completed,
      ),
    ).toBe(true);
    expect(
      (await request(worker, `/session/${sessionID}/abort`, { method: "POST" }))
        .status,
    ).toBe(200);
    await pending;
    expect(worker.faux!.state.callCount).toBe(2);
    const messages = await history();
    expect(
      messages.find((m) => m.info.parentID === input.messageID)?.info.error,
    ).toBeDefined();
    expect(
      items.filter(
        (i: any) => i.kind === "entry" && i.entry.type === "compaction",
      ),
    ).toHaveLength(0);
  });

  test('commits summary and display atomically, preserves history, and compacts the next model context after replacement', async () => {
    const { items, config, worker, post, compactBody, history } = await fixture();
    const before = await history();
    worker.faux!.setResponses([fauxAssistantMessage('The launch code is cobalt. SUMMARY_COMPACTED')]);
    const compacted = await post(worker, 'summarize', compactBody);
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toBe(true);
    const after = await history();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1).info.summary).toBe(true);
    expect(after.at(-1).parts.some((p: any) => p.text?.includes('SUMMARY_COMPACTED'))).toBe(true);
    expect(after.at(-2).parts.some((p: any) => p.type === 'compaction')).toBe(true);
    const entries = items.filter((item: any) => item.kind === 'entry' && item.entry.type === 'compaction');
    expect(entries).toHaveLength(1);
    expect((entries[0] as any)._kortixTurnLease).toBeDefined();
    expect(worker.env.calls).toHaveLength(0);
    await worker.close();
    const replacement = await startWorker(config);
    workers.push(replacement);
    expect(await history(replacement)).toEqual(after);
    let context = '';
    replacement.faux!.setResponses([(ctx) => { context = JSON.stringify(ctx.messages); return fauxAssistantMessage('cobalt'); }]);
    expect((await post(replacement, 'message', { parts: [{ type: 'text', text: 'What is the launch code?' }] })).status).toBe(200);
    expect(context).toContain('SUMMARY_COMPACTED');
    expect(context).toContain('What is the launch code?');
    expect(context).not.toContain('OLD_USER_DETAIL');
    expect(context.match(/OLD_ASSISTANT_DETAIL/g)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(context).not.toContain('Compact conversation context.');
  });

  test('Stop cancels summary generation and the next prompt keeps the original context', async () => {
    const { items, worker, sessionID, post, compactBody, history } = await fixture();
    const entered = deferred();
    worker.faux!.setResponses([async (_ctx, options) => {
      entered.resolve();
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) resolve();
        else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return fauxAssistantMessage([], { stopReason: 'aborted', errorMessage: 'stopped' });
    }]);
    const pending = post(worker, 'summarize', compactBody);
    await entered.promise;
    const status = await (await request(worker, '/session/status')).json() as Record<string, { type: string }>;
    expect(status[sessionID]?.type).toBe('busy');
    expect((await request(worker, `/session/${sessionID}/abort`, { method: 'POST' })).status).toBe(200);
    expect((await pending).status).toBe(409);
    expect(items.filter((item: any) => item.kind === 'entry' && item.entry.type === 'compaction')).toHaveLength(0);
    const stopped = await history();
    expect(stopped.at(-1).info.summary).toBe(true);
    expect(stopped.at(-1).info.error).toBeDefined();
    let context = '';
    worker.faux!.setResponses([(ctx) => { context = JSON.stringify(ctx.messages); return fauxAssistantMessage('continued'); }]);
    expect((await post(worker, 'message', { parts: [{ type: 'text', text: 'Continue after Stop.' }] })).status).toBe(200);
    expect(context).toContain('OLD_USER_DETAIL');
    expect(context).toContain('Continue after Stop.');
  });

  test('serializes an admitted prompt behind compaction and retries the same compaction without charging twice', async () => {
    const { items, worker, post, compactBody, history } = await fixture();
    const entered = deferred();
    const release = deferred();
    let promptContext = '';
    let summaryCalls = 0;
    worker.faux!.setResponses([
      async () => { summaryCalls++; entered.resolve(); await release.promise; return fauxAssistantMessage('SERIAL_SUMMARY'); },
      ctx => { promptContext = JSON.stringify(ctx.messages); return fauxAssistantMessage('next done'); },
    ]);
    const input = { ...compactBody, messageID: mintWireMessageId({ nowMs: Date.now() + 1000 }).id };
    const pending = post(worker, 'summarize', input);
    await entered.promise;
    const next = post(worker, 'message', { parts: [{ type: 'text', text: 'QUEUED_AFTER_COMPACTION' }] });
    release.resolve();
    expect((await pending).status).toBe(200);
    expect((await next).status).toBe(200);
    expect(promptContext).toContain('SERIAL_SUMMARY');
    expect(promptContext).toContain('QUEUED_AFTER_COMPACTION');
    const beforeRetry = await history();
    expect((await post(worker, 'summarize', input)).status).toBe(200);
    expect(await history()).toEqual(beforeRetry);
    expect(summaryCalls).toBe(1);
    expect(items.filter((item: any) => item.kind === 'entry' && item.entry.type === 'compaction')).toHaveLength(1);
  });

  test('replacement completes an atomically saved compaction when the owner dies before journal completion', async () => {
    const { items, config, worker, post, compactBody, history } = await fixture();
    worker.faux!.setResponses([fauxAssistantMessage('CRASH_SAFE_SUMMARY')]);
    expect((await post(worker, 'summarize', compactBody)).status).toBe(200);
    const expected = await history();
    const index = items.findIndex((item: any) => item.kind === 'entry' && item.entry.type === 'compaction');
    expect(index).toBeGreaterThan(0);
    const atCommit = structuredClone(items.slice(0, index + 1));
    await worker.close();
    const replacement = await startWorker({ ...config, storeUrl: await sharedStore(atCommit) });
    workers.push(replacement);
    expect(await history(replacement)).toEqual(expected);
    expect(atCommit.filter((item: any) => item.kind === 'entry' && item.entry.type === 'compaction')).toHaveLength(1);
    expect(replacement.faux!.state.callCount).toBe(0);
    replacement.faux!.setResponses([fauxAssistantMessage('continued')]);
    expect((await post(replacement, 'message', { parts: [{ type: 'text', text: 'Continue after replacement.' }] })).status).toBe(200);
  });

  test('replacement interrupts an unsaved compaction without losing history or replaying its model call', async () => {
    const { items, config, worker, post, compactBody, history } = await fixture();
    const before = await history();
    const entered = deferred();
    const release = deferred();
    worker.faux!.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage('late result'); }]);
    const pending = post(worker, 'summarize', compactBody);
    await entered.promise;
    const atCrash = structuredClone(items);
    release.resolve();
    await pending;
    await worker.close();
    const replacement = await startWorker({ ...config, storeUrl: await sharedStore(atCrash) });
    workers.push(replacement);
    const restored = await history(replacement);
    expect(restored.slice(0, before.length)).toEqual(before);
    expect(restored.at(-1).info.summary).toBe(true);
    expect(restored.at(-1).info.error).toBeDefined();
    expect(restored.at(-1).parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')).toBe('');
    expect(replacement.faux!.state.callCount).toBe(0);
    expect(atCrash.filter((item: any) => item.kind === 'entry' && item.entry.type === 'compaction')).toHaveLength(0);
  });

  test('repeated compaction summarizes the previous summary and newer turns without duplicating old context', async () => {
    const { worker, post, compactBody } = await fixture();
    let summaryInput = '';
    let nextContext = '';
    worker.faux!.setResponses([fauxAssistantMessage('FIRST_CONTEXT_SUMMARY')]);
    expect((await post(worker, 'summarize', compactBody)).status).toBe(200);
    worker.faux!.setResponses([fauxAssistantMessage('A newer decision is amber.')]);
    expect((await post(worker, 'message', { parts: [{ type: 'text', text: 'Add the amber decision.' }] })).status).toBe(200);
    worker.faux!.setResponses([0, 1].map(() => ctx => {
      summaryInput += JSON.stringify(ctx);
      return fauxAssistantMessage('SECOND_CONTEXT_SUMMARY includes cobalt and amber.');
    }));
    expect((await post(worker, 'summarize', compactBody)).status).toBe(200);
    worker.faux!.setResponses([ctx => { nextContext = JSON.stringify(ctx.messages); return fauxAssistantMessage('cobalt and amber'); }]);
    expect(summaryInput).toContain('FIRST_CONTEXT_SUMMARY');
    expect(summaryInput).toContain('amber');
    expect((await post(worker, 'message', { parts: [{ type: 'text', text: 'Recall both decisions.' }] })).status).toBe(200);
    expect(nextContext).toContain('SECOND_CONTEXT_SUMMARY');
    expect(nextContext).not.toContain('FIRST_CONTEXT_SUMMARY');
    expect(nextContext).not.toContain('OLD_USER_DETAIL');
  });

  test('an oversized summary fails before storage mutation and leaves the conversation usable', async () => {
    const { worker, items, post, compactBody, history } = await fixture(false, DEFAULT_TURN_OWNER_LEASE_MS);
    const before = await history();
    worker.faux!.setResponses([fauxAssistantMessage('summary'.repeat(100000))]);
    expect((await post(worker, 'summarize', compactBody)).status).toBe(409);
    expect(items.filter((item: any) => item.kind === 'entry' && item.entry.type === 'compaction')).toHaveLength(0);
    const failed = await history();
    expect(failed.slice(0, before.length)).toEqual(before);
    expect(failed.at(-1).info.error).toBeDefined();
    worker.faux!.setResponses([fauxAssistantMessage('still usable')]);
    expect((await post(worker, 'message', { parts: [{ type: 'text', text: 'Continue.' }] })).status).toBe(200);
  });

  test('rejects another model, malformed options, and an unknown session before any summary call', async () => {
    const { worker, post, compactBody, history } = await fixture();
    const before = await history();
    for (const body of [{ ...compactBody, modelID: 'other' }, { ...compactBody, auto: 'yes' }, { ...compactBody, extra: true }, []]) {
      expect((await post(worker, 'summarize', body)).status).toBe(400);
    }
    expect((await request(worker, '/session/unknown/summarize', { method: 'POST', body: JSON.stringify(compactBody) })).status).toBe(404);
    expect(await history()).toEqual(before);
  });
});
