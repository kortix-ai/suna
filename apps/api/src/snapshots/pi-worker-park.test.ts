import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createSocketServer } from 'node:net';
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

/**
 * Kill the park process AND the worker it spawned.
 *
 * `child.kill()` reaches only park.mjs. The worker is its GRANDchild, so it is
 * reparented to init and keeps port bound. A later `bootPark` that draws that
 * port then probes a stranger's worker, gets `{runtimeReady:true}` with no
 * `parked` field, and the handshake test fails on `parked === undefined` — a
 * flake whose rate climbs with every run that leaked one. `detached: true`
 * makes park a process-group leader so the whole group dies together.
 */
function killTree(target: ChildProcess | null): void {
  if (!target?.pid) return;
  try {
    process.kill(-target.pid, 'SIGKILL');
  } catch {
    // group already gone
  }
  try {
    target.kill('SIGKILL');
  } catch {
    // already gone
  }
}

/** Let the OS pick a free port instead of gambling inside a fixed range. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createSocketServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

afterEach(async () => {
  killTree(child);
  child = null;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function bootPark(reuseRoot?: string): Promise<{ port: number; base: string; root: string }> {
  const root = reuseRoot ?? (await mkdtemp(join(tmpdir(), 'kortix-park-')));
  if (!reuseRoot) roots.push(root);
  await writeFile(join(root, 'park.mjs'), piWorkerParkScriptForTest());
  await writeFile(join(root, 'fetch-runtime.mjs'), FAKE_FETCH);
  await writeFile(join(root, 'session-worker.mjs'), FAKE_WORKER);
  const port = await freePort();
  child = spawn('node', [join(root, 'park.mjs')], {
    detached: true,
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
      if (res.ok) return { port, base, root };
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('park server never came up');
}

describe('pi worker park server', () => {
  /**
   * A CLAIMED box must come back as a worker, not as a parked box.
   *
   * The claim env arrived over HTTP and was spawned into a child process. The
   * container's own environment still carries `KORTIX_PI_PARK=1`, so the first
   * stop/resume re-ran the entrypoint, which execed this script again — with
   * the claim env gone. Port 8000 then answered
   * `{parked:true,runtimeReady:false}` forever, `shouldBootstrapSessionRuntime`
   * retried once, and the session could never run another turn. Its transcript
   * survived; nothing else did. A cold-created box resumed fine, so the failure
   * hit only the pool's fast path and read as random.
   *
   * The claim therefore has to be DURABLE on the box: persisted at claim time,
   * and preferred over parking on every later boot.
   */
  test('RESUME: a box claimed once boots the worker again, never re-parks', async () => {
    const first = await bootPark();
    const claim = await fetch(`${first.base}/kortix/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-park-token': 'park-tok' },
      body: JSON.stringify({ env: CLAIM_ENV }),
    });
    expect(claim.status).toBe(200);

    // Let the handoff complete, then kill the box as a stop/resume would.
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${first.base}/kortix/health`);
        const j = (await r.json()) as { runtimeReady?: boolean };
        if (j.runtimeReady) break;
      } catch {
        // mid-handoff
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    killTree(child);
    child = null;
    await new Promise((r) => setTimeout(r, 200));

    // Same box, same disk, same park env — exactly what a resume re-runs.
    const second = await bootPark(first.root);
    const health = (await (await fetch(`${second.base}/kortix/health`)).json()) as {
      parked?: boolean;
      runtimeReady?: boolean;
      sessionId?: string | null;
    };
    expect(health.parked).toBeUndefined();
    expect(health.runtimeReady).toBe(true);
    // And it is THIS session's worker, restored from the persisted claim.
    expect(health.sessionId).toBe(CLAIM_ENV.KORTIX_SESSION_ID);
  });

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
