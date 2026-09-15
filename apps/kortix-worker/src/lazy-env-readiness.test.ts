import { afterEach, describe, expect, test } from 'bun:test';
import { LazyKortixEnv } from './lazy-env';

const cleanup: Array<() => unknown> = [];
afterEach(() => { for (const stop of cleanup.splice(0)) stop(); });

describe('worker environment readiness', () => {
  test.each([
    { repo_ready: true },
    { workload: 'session', opencode: 'ok', runtimeReady: true },
    { workload: 'environment', opencode: 'disabled', runtimeReady: false },
  ])('refuses workspace operations until the execution-only daemon is ready: %j', async (health) => {
    let operations = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request: Request): Response {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/environment/ensure')) return Response.json({
          status: 'active', external_id: 'environment', preview_url: server.url.origin, rpc_secret: 'fixture-secret',
        });
        if (path === '/kortix/health') return Response.json(health);
        operations++;
        return Response.json({ ok: true, value: 'must not execute' });
      },
    });
    cleanup.push(() => server.stop(true));
    const env = new LazyKortixEnv({ apiUrl: server.url.origin, token: 'fixture', projectId: 'project', sessionId: 'session', cwd: '/workspace', ensureTimeoutMs: 100 });
    const result = await env.readTextFile('/workspace/example.txt');
    expect(result.ok).toBe(false);
    expect(operations).toBe(0);
    await env.cleanup();
  });
});
