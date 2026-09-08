import { afterEach, describe, expect, test } from 'bun:test';
import type { Agent, ToolIds, ToolList } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

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

async function start() {
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: 'review' },
    agentConfig: {
      model: 'openrouter/anthropic/claude-sonnet-4.5',
      agent: {
        review: {
          description: 'Review the selected change.',
          mode: 'primary',
          model: 'openrouter/anthropic/claude-sonnet-4.5',
          variant: 'high',
          temperature: 0.2,
          top_p: 0.8,
          prompt: 'Review carefully.',
          hidden: false,
          options: { reasoning: 'enabled' },
          color: '#123456',
          steps: 12,
          permission: { bash: 'ask', skill: { '*': 'deny', release: 'allow' } },
        },
        ignored: { description: 'This agent is not compiled for this worker.' },
      },
    },
    skills: [
      {
        name: 'release',
        description: 'Prepare a release.',
        location: '.kortix/pi/skills/release/SKILL.md',
        content: 'Release instructions.',
        files: [],
      },
    ],
  };
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Answer exactly.',
    modelMode: 'faux',
    sessionId: `discovery-routes-${workers.length}`,
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  return worker;
}

function request(
  worker: Awaited<ReturnType<typeof startWorker>>,
  path: string,
  authenticated = true,
) {
  return fetch(`http://127.0.0.1:${worker.port}${path}`, {
    headers: authenticated ? { authorization: 'Bearer runtime-token' } : {},
  });
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

describe('Pi OpenCode discovery routes', () => {
  test('returns only the selected compiled agent through the installed SDK', async () => {
    const worker = await start();

    const result = await client(worker).app.agents({ directory: '/workspace' });
    expect(result.error).toBeUndefined();
    const agents: Agent[] = result.data ?? [];
    expect(agents).toEqual([
      {
        name: 'review',
        description: 'Review the selected change.',
        mode: 'primary',
        native: false,
        hidden: false,
        topP: 0.8,
        temperature: 0.2,
        color: '#123456',
        permission: expect.arrayContaining([
          { permission: 'bash', pattern: '*', action: 'ask' },
          { permission: 'skill', pattern: '*', action: 'deny' },
          { permission: 'skill', pattern: 'release', action: 'allow' },
        ]),
        model: { providerID: 'kortix', modelID: 'openrouter/anthropic/claude-sonnet-4.5' },
        variant: 'high',
        prompt: 'Review carefully.',
        options: { reasoning: 'enabled' },
        steps: 12,
      },
    ]);
  });

  test('returns the effective Pi tool IDs and JSON schemas through the installed SDK', async () => {
    const worker = await start();
    const sdk = client(worker);

    const idsResult = await sdk.tool.ids({ directory: '/workspace' });
    const listResult = await sdk.tool.list({
      directory: '/workspace',
      provider: 'kortix',
      model: 'openrouter/anthropic/claude-sonnet-4.5',
    });
    expect(idsResult.error).toBeUndefined();
    expect(listResult.error).toBeUndefined();
    const ids: ToolIds = idsResult.data ?? [];
    const tools: ToolList = listResult.data ?? [];
    expect(ids).toEqual(['bash', 'read', 'write', 'edit', 'glob', 'grep', 'question', 'todowrite', 'todoread', 'websearch', 'webfetch', 'skill']);
    expect(tools.map((tool) => tool.id)).toEqual(ids);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toMatchObject({ type: 'object', properties: expect.any(Object) });
    }
    expect(tools.find((tool) => tool.id === 'question')?.parameters).toMatchObject({
      required: ['questions'],
      properties: { questions: { type: 'array' } },
    });
    expect(tools.find((tool) => tool.id === 'websearch')?.parameters).toMatchObject({
      required: ['query'],
      properties: { query: { type: 'string' }, numResults: { type: 'integer' }, livecrawl: { anyOf: expect.any(Array) } },
    });
    expect(tools.find((tool) => tool.id === 'skill')?.parameters).toMatchObject({
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
  });

  test('serves non-experimental tool aliases with the same response bodies', async () => {
    const worker = await start();
    const query =
      'directory=%2Fworkspace&provider=kortix&model=openrouter%2Fanthropic%2Fclaude-sonnet-4.5';

    const [legacyIds, directIds, legacyTools, directTools] = await Promise.all([
      request(worker, '/experimental/tool/ids?directory=%2Fworkspace'),
      request(worker, '/tool/ids?directory=%2Fworkspace'),
      request(worker, `/experimental/tool?${query}`),
      request(worker, `/tool?${query}`),
    ]);
    expect([legacyIds.status, directIds.status, legacyTools.status, directTools.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(await directIds.json()).toEqual(await legacyIds.json());
    expect(await directTools.json()).toEqual(await legacyTools.json());
  });

  test('authenticates discovery and validates workspace and tool-list queries', async () => {
    const worker = await start();

    for (const path of [
      '/agent',
      '/experimental/tool/ids',
      '/tool/ids',
      '/experimental/tool?provider=kortix&model=x',
      '/tool?provider=kortix&model=x',
    ]) {
      expect((await request(worker, path, false)).status).toBe(401);
    }
    for (const path of [
      '/agent?directory=%2Fother',
      '/experimental/tool/ids?workspace=%2Fother',
      '/tool/ids?directory=%2Fother',
      '/experimental/tool?directory=%2Fother&provider=kortix&model=x',
      '/tool?workspace=%2Fother&provider=kortix&model=x',
    ]) {
      expect((await request(worker, path)).status).toBe(400);
    }
    for (const path of ['/tool', '/tool?provider=kortix', '/experimental/tool?model=x']) {
      expect((await request(worker, path)).status).toBe(400);
    }
  });
});
