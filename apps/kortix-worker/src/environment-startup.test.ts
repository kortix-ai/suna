import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { configFromEnv, startWorker, type WorkerConfig } from './worker.ts';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(startup?: 'lazy' | 'prewarm') {
  const entries: unknown[] = [];
  const appends = new Set<string>();
  const calls: string[] = [];
  let origin = '';
  const api = createServer(async (req, res) => {
    const path = new URL(req.url!, origin).pathname;
    res.setHeader('content-type', 'application/json');
    if (path.startsWith('/log') && req.method === 'GET') {
      res.end(JSON.stringify(entries));
    } else if (path.startsWith('/log') && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!key || !appends.has(key)) {
        entries.push(JSON.parse(body));
        appends.add(key);
      }
      res.writeHead(204).end();
    } else if (path.endsWith('/environment/ensure')) {
      calls.push('ensure');
      res.end(JSON.stringify({
        status: 'active', external_id: 'environment-test',
        preview_url: origin, rpc_secret: 'test-rpc-secret',
      }));
    } else if (path === '/kortix/health') {
      res.end(JSON.stringify({ repo_ready: true }));
    } else if (path === '/kortix/env-rpc/rpc-ws') {
      res.writeHead(404).end();
    } else if (path.startsWith('/kortix/env-rpc')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { op, args } = JSON.parse(body);
      calls.push(op);
      const value = op === 'exec'
        ? { stdout: 'environment-output', stderr: '', exitCode: 0 }
        : op === 'absolutePath' ? args.path : true;
      res.end(JSON.stringify({ ok: true, value }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
  const sockets = new WebSocketServer({ server: api });
  sockets.on('connection', (socket) => {
    socket.on('message', (data) => {
      const { id, op, args } = JSON.parse(String(data));
      calls.push(op);
      const value = op === 'exec'
        ? { stdout: 'environment-output', stderr: '', exitCode: 0 }
        : op === 'absolutePath' ? args.path : true;
      socket.send(JSON.stringify({ id, body: { ok: true, value } }));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cleanups.push(() => new Promise<void>((resolve) => {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    api.closeAllConnections();
    api.close(() => resolve());
  }));
  const cfg: WorkerConfig = {
    port: 0, envUrl: origin, envCwd: '/workspace', apiUrl: `${origin}/v1`,
    projectId: 'test-project', sessionId: 'test-session', kortixToken: 'test-token',
    storeUrl: `${origin}/log`, systemPrompt: 'Answer exactly.', modelMode: 'faux',
    ...(startup ? { environmentStartup: startup } : {}),
  };
  const worker = await startWorker(cfg);
  cleanups.push(async () => {
    await worker.env.cleanup();
    worker.server.closeAllConnections();
    await worker.close();
  });
  const request = (path: string, init: RequestInit = {}) => fetch(
    `http://127.0.0.1:${worker.port}${path}`,
    { ...init, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' } },
  );
  const sessions = await (await request('/session')).json() as Array<{ id: string }>;
  return {
    worker, calls,
    prompt: async () => {
      const path = `/session/${sessions[0].id}`;
      const before = await (await request(`${path}/message`)).json() as unknown[];
      const accepted = await request(`${path}/prompt_async`, {
        method: 'POST', body: JSON.stringify({ parts: [{ type: 'text', text: 'Answer now.' }] }),
      });
      expect(accepted.status).toBe(204);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        const response = await request(`${path}/message`);
        const messages = await response.clone().json() as Array<{
          info: { role: string; time?: { completed?: number } };
          parts: Array<{ type: string }>;
        }>;
        const latest = messages.at(-1);
        if (messages.length > before.length && latest?.info.role === 'assistant'
          && latest.info.time?.completed
          && latest.parts.some((part) => part.type === 'text')) return response;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('The prompt did not produce a completed assistant message');
    },
  };
}

describe('environment startup policy through the prompt route', () => {
  test('a completed text-only turn does not provision compute by default', async () => {
    const h = await harness();
    h.worker.faux!.setResponses([fauxAssistantMessage('No computer needed.')]);
    const response = await h.prompt();
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('No computer needed.');
    expect(h.calls).toEqual([]);
  });

  test('explicit lazy mode starts compute on the first shell tool and reuses it', async () => {
    const h = await harness('lazy');
    h.worker.faux!.setResponses([fauxAssistantMessage('No computer yet.')]);
    expect((await h.prompt()).status).toBe(200);
    expect(h.calls).toEqual([]);
    h.worker.faux!.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: 'echo first' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('bash', { command: 'echo second' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Both commands finished.'),
    ]);
    const response = await h.prompt();
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('Both commands finished.');
    expect(h.calls.filter((call) => call === 'ensure')).toHaveLength(1);
    expect(h.calls.filter((call) => call === 'exec')).toHaveLength(2);
  });

  test('explicit prewarm mode prepares compute for a text-only prompt', async () => {
    const h = await harness('prewarm');
    expect(h.calls).toEqual([]);
    h.worker.faux!.setResponses([fauxAssistantMessage('Compute can prepare in parallel.')]);
    expect((await h.prompt()).status).toBe(200);
    expect(h.calls).toEqual(['ensure']);
  });
});

describe('environment startup configuration', () => {
  test('defaults to lazy and accepts only an explicit prewarm opt-in', () => {
    const before = process.env.KORTIX_ENV_STARTUP;
    try {
      delete process.env.KORTIX_ENV_STARTUP;
      expect(configFromEnv()).toMatchObject({ environmentStartup: 'lazy' });
      process.env.KORTIX_ENV_STARTUP = 'prewarm';
      expect(configFromEnv()).toMatchObject({ environmentStartup: 'prewarm' });
      process.env.KORTIX_ENV_STARTUP = 'lazy';
      expect(configFromEnv()).toMatchObject({ environmentStartup: 'lazy' });
      process.env.KORTIX_ENV_STARTUP = 'typo';
      expect(() => configFromEnv()).toThrow('KORTIX_ENV_STARTUP');
    } finally {
      if (before === undefined) delete process.env.KORTIX_ENV_STARTUP;
      else process.env.KORTIX_ENV_STARTUP = before;
    }
  });
});
