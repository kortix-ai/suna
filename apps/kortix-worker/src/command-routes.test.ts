import { afterEach, describe, expect, test } from 'bun:test';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

import type { PiCommand } from './command-runtime.ts';
import { startWorker } from './worker.ts';

const workers: Array<Awaited<ReturnType<typeof startWorker>>> = [];
const globals = globalThis as Record<string, unknown>;
const originalCompiled = globals.__KORTIX_COMPILED__;

afterEach(async () => {
  globals.__KORTIX_COMPILED__ = originalCompiled;
  await Promise.all(
    workers.splice(0).map((worker) => {
      worker.server.closeAllConnections();
      return worker.close();
    }),
  );
});

async function start(commands: PiCommand[]) {
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: 'build', command_config_etag: 'command-etag' },
    agentConfig: { agent: { build: {} } },
    commands,
  };
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Answer exactly.',
    modelMode: 'faux',
    sessionId: `command-routes-${workers.length}`,
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

function client(worker: Awaited<ReturnType<typeof startWorker>>) {
  return createOpencodeClient({
    baseUrl: `http://127.0.0.1:${worker.port}`,
    fetch: (async (input, init) => {
      const outbound = new Request(input, init);
      outbound.headers.set('authorization', 'Bearer runtime-token');
      return fetch(outbound);
    }) as typeof fetch,
  });
}

async function rootId(worker: Awaited<ReturnType<typeof startWorker>>): Promise<string> {
  const sessions = (await (await request(worker, '/session')).json()) as Array<{ id: string }>;
  const session = sessions[0];
  if (!session) throw new Error('worker returned no root session');
  return session.id;
}

describe('Pi OpenCode command routes', () => {
  test('lists immutable compiled commands on raw and runtime-state surfaces', async () => {
    const commands = [
      {
        name: 'review',
        description: 'Review code',
        template: 'Review $ARGUMENTS',
        source: 'command' as const,
        hints: ['$ARGUMENTS'],
      },
    ];
    const worker = await start(commands);

    const listed = await client(worker).command.list({ directory: '/workspace' });
    expect(listed.error).toBeUndefined();
    expect(listed.data).toEqual(commands);
    const state = (await (await request(worker, '/kortix/opencode/state')).json()) as {
      commands: { known: boolean; value: PiCommand[] };
      identity: { command_config_etag?: string };
    };
    expect(state.commands).toEqual({ known: true, value: commands });
    expect(state.identity.command_config_etag).toBe('command-etag');
  });

  test('expands and runs a command through the blocking OpenCode route', async () => {
    const worker = await start([
      {
        name: 'review',
        description: 'Review code',
        template: 'Review $1 against $2',
        source: 'command',
        hints: ['$1', '$2'],
      },
    ]);
    if (!worker.faux) throw new Error('faux provider is unavailable');
    worker.faux.setResponses([fauxAssistantMessage('Review complete.')]);
    const sessionID = await rootId(worker);

    const eventController = new AbortController();
    const eventResponse = await request(worker, '/global/event', {
      signal: eventController.signal,
    });
    const eventReader = eventResponse.body?.getReader();
    if (!eventReader) throw new Error('global event response has no body');
    const response = await client(worker).session.command({
      sessionID,
      directory: '/workspace',
      command: 'review',
      arguments: 'src/main.ts "release branch"',
    });
    expect(response.error).toBeUndefined();
    expect(
      response.data?.parts.some((part) => part.type === 'text' && part.text === 'Review complete.'),
    ).toBe(true);

    const user = worker.agent.state.messages.findLast(
      (message: { role?: string }) => message.role === 'user',
    ) as { content?: Array<{ type: string; text?: string }> } | undefined;
    expect(user?.content).toEqual([
      { type: 'text', text: 'Review src/main.ts against release branch' },
    ]);

    let events = '';
    while (!events.includes('command.executed')) {
      const chunk = await eventReader.read();
      if (chunk.done) break;
      events += new TextDecoder().decode(chunk.value, { stream: true });
    }
    eventController.abort();
    expect(events).toContain('command.executed');
    expect(events).toContain('review');
  });

  test('treats omitted command arguments as an empty string like the generated client', async () => {
    const worker = await start([
      {
        name: 'review',
        template: 'Review the current changes.',
        source: 'command',
        hints: [],
      },
    ]);
    if (!worker.faux) throw new Error('faux provider is unavailable');
    worker.faux.setResponses([fauxAssistantMessage('Review complete.')]);
    const sessionID = await rootId(worker);

    const response = await client(worker).session.command({
      sessionID,
      directory: '/workspace',
      command: 'review',
    });

    expect(response.error).toBeUndefined();
    const user = worker.agent.state.messages.findLast(
      (message: { role?: string }) => message.role === 'user',
    ) as { content?: Array<{ type: string; text?: string }> } | undefined;
    expect(user?.content).toEqual([{ type: 'text', text: 'Review the current changes.' }]);
  });

  test('returns explicit errors for unknown commands and unsupported semantics', async () => {
    const worker = await start([
      {
        name: 'delegate',
        template: 'Delegate $ARGUMENTS',
        subtask: true,
        source: 'command',
        hints: ['$ARGUMENTS'],
      },
      { name: 'shell', template: 'Inspect !`git status`', source: 'command', hints: [] },
      {
        name: 'review',
        template: 'Review $ARGUMENTS',
        source: 'command',
        hints: ['$ARGUMENTS'],
      },
    ]);
    const sessionID = await rootId(worker);
    const execute = (command: string, extra: Record<string, unknown> = {}) =>
      request(worker, `/session/${sessionID}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command, arguments: '', ...extra }),
      });

    const missing = await execute('missing');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      code: 'PI_COMMAND_NOT_FOUND',
      error: 'Command not found: "missing".',
    });

    for (const [command, feature] of [
      ['delegate', 'subtask execution'],
      ['shell', 'shell interpolation'],
    ] as const) {
      const response = await execute(command);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        code: 'PI_COMMAND_FEATURE_UNSUPPORTED',
        feature,
      });
    }

    for (const field of ['agent', 'model', 'variant', 'subtask']) {
      const response = await execute('review', { [field]: 'stale-selection' });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'PI_COMMAND_RUNTIME_OVERRIDE_UNSUPPORTED',
        field,
      });
    }
    const parts = await execute('review', { parts: [] });
    expect(parts.status).toBe(422);
    expect(await parts.json()).toMatchObject({
      code: 'PI_COMMAND_FEATURE_UNSUPPORTED',
      feature: 'file parts',
    });
    expect(worker.agent.state.messages).toEqual([]);
  });

  test('validates auth, session, workspace, and body before execution', async () => {
    const worker = await start([
      {
        name: 'review',
        template: 'Review $ARGUMENTS',
        source: 'command',
        hints: ['$ARGUMENTS'],
      },
    ]);
    const sessionID = await rootId(worker);

    expect(
      (
        await fetch(`http://127.0.0.1:${worker.port}/session/${sessionID}/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'review', arguments: '' }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await request(worker, '/session/not-this-session/command', { method: 'POST' })).status,
    ).toBe(404);
    expect(
      (
        await request(worker, `/session/${sessionID}/command?directory=/tmp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'review', arguments: '' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(worker, `/session/${sessionID}/command?workspace=/tmp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'review', arguments: '' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(worker, `/session/${sessionID}/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command: 'review', arguments: 42 }),
        })
      ).status,
    ).toBe(400);
  });
});
