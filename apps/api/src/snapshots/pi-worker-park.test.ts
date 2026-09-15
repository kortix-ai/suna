import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piWorkerParkScriptForTest } from './build-context';

// The real park script (the exact bytes baked into the pi-worker snapshot)
// driven through its whole protocol: health-while-parked, token gate, env
// validation, single-accept, and the port handoff to the claimed worker. The
// fetch and worker stages are stand-ins — their contract (spawned with the
// merged claim env, worker inherits the port) is what this asserts.
const FAKE_FETCH = `
if (!process.env.KORTIX_TOKEN || !process.env.KORTIX_PI_RUNTIME_SHA) process.exit(3);
process.exit(0);
`;
const FAKE_WORKER = `
import { createServer } from 'node:http';
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    runtimeReady: true,
    sessionId: process.env.KORTIX_SESSION_ID ?? null,
  }));
}).listen(Number(process.env.PORT));
`;

const CLAIM_ENV = {
  KORTIX_API_URL: 'https://api.kortix.test/v1',
  KORTIX_TOKEN: 'session-token',
  KORTIX_PROJECT_ID: 'proj-1',
  KORTIX_SESSION_ID: 'sess-42',
  KORTIX_PI_RUNTIME_REF: 'main',
  KORTIX_PI_RUNTIME_SHA: 'a'.repeat(40),
};

let child: ChildProcess | null = null;
const roots: string[] = [];
afterEach(async () => {
  child?.kill('SIGKILL');
  child = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bootPark(): Promise<{ port: number; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-park-'));
  roots.push(root);
  await writeFile(join(root, 'park.mjs'), piWorkerParkScriptForTest());
  await writeFile(join(root, 'fetch-runtime.mjs'), FAKE_FETCH);
  await writeFile(join(root, 'session-worker.mjs'), FAKE_WORKER);
  const port = 18800 + Math.floor(Math.random() * 500);
  child = spawn('node', [join(root, 'park.mjs')], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      KORTIX_PI_PARK: '1',
      KORTIX_PI_PARK_TOKEN: 'park-tok',
      KORTIX_PI_PARK_DIR: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/kortix/health`);
      if (res.ok) return { port, base };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('park server never came up');
}

describe('pi worker park server', () => {
  test('full claim handshake hands the port to a worker running the claim env', async () => {
    const { base } = await bootPark();

    const parked = (await (await fetch(`${base}/kortix/health`)).json()) as {
      parked?: boolean;
      runtimeReady?: boolean;
    };
    expect(parked.parked).toBe(true);
    expect(parked.runtimeReady).toBe(false);

    const badToken = await fetch(`${base}/kortix/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-park-token': 'wrong' },
      body: JSON.stringify({ env: CLAIM_ENV }),
    });
    expect(badToken.status).toBe(401);

    const badEnv = await fetch(`${base}/kortix/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-park-token': 'park-tok' },
      body: JSON.stringify({ env: { ...CLAIM_ENV, NOT_KORTIX: 'x' } }),
    });
    expect(badEnv.status).toBe(400);

    const missing = await fetch(`${base}/kortix/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-park-token': 'park-tok' },
      body: JSON.stringify({ env: { KORTIX_API_URL: 'https://api.kortix.test/v1' } }),
    });
    expect(missing.status).toBe(400);

    const claim = await fetch(`${base}/kortix/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-park-token': 'park-tok' },
      body: JSON.stringify({ env: CLAIM_ENV }),
    });
    expect(claim.status).toBe(200);

    // Single-accept: a second claim is refused — 409 while the park server is
    // still draining, or a connection error once it has already closed the
    // port for the worker. Both prove the box can never serve two sessions.
    const second = await fetch(`${base}/kortix/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-park-token': 'park-tok' },
      body: JSON.stringify({ env: { ...CLAIM_ENV, KORTIX_SESSION_ID: 'sess-43' } }),
    }).then(
      (res) => res.status,
      () => 'refused',
    );
    expect([409, 'refused']).toContain(second as never);

    // The worker takes over the SAME port with the claim env applied.
    interface WorkerHealth {
      runtimeReady?: boolean;
      sessionId?: string | null;
      parked?: boolean;
    }
    let worker: WorkerHealth | null = null;
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`${base}/kortix/health`);
        if (res.ok) {
          const body = (await res.json()) as WorkerHealth;
          if (!body?.parked) {
            worker = body;
            break;
          }
        }
      } catch {
        // handoff gap
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(worker?.runtimeReady).toBe(true);
    expect(worker?.sessionId).toBe('sess-42');
  }, 20_000);
});
