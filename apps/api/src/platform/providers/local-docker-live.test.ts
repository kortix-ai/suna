// LIVE integration test against the REAL local Docker daemon — no mocks.
// Skipped unless RUN_LOCAL_DOCKER_LIVE=1 (this machine has Docker; CI does
// not enable this by default). Builds a TINY stand-in image (busybox's static
// httpd — no network needed, `alpine` is already cached locally) rather than
// the full multi-GB sandbox image, and exercises the exact same
// create/stop/start/remove/ingress lifecycle a real session goes through.
//
// Run: `RUN_LOCAL_DOCKER_LIVE=1 dotenvx run -- bun test src/platform/providers/local-docker-live.test.ts`
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'local-docker';
process.env.KORTIX_URL = 'http://localhost:8008';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'http://localhost:3000';

const RUN_LIVE = process.env.RUN_LOCAL_DOCKER_LIVE === '1';
const describeLive = RUN_LIVE ? describe : describe.skip;

// Dedicated, disposable network/image tag names so this never collides with a
// real self-host instance's own `kortix-local-docker` network on the same
// machine.
const TEST_NETWORK = `kortix-ld-live-net-${randomUUID().slice(0, 8)}`;
const TEST_IMAGE = `kortix-ld-live-image-${randomUUID().slice(0, 8)}:latest`;
process.env.LOCAL_DOCKER_NETWORK = TEST_NETWORK;

const { LocalDockerProvider } = await import('./local-docker');

let docker: Docker;
let buildContextDir: string;
const createdExternalIds: string[] = [];

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  return last!;
}

describeLive('local-docker provider — LIVE against the real Docker daemon', () => {
  beforeAll(async () => {
    docker = new Docker();
    await docker.ping(); // fail fast + loud if Docker genuinely isn't available here

    // Tiny stand-in for the agent daemon: busybox's built-in static httpd,
    // baked into `alpine` — no package install, no network fetch at build time.
    buildContextDir = await mkdtemp(join(tmpdir(), 'kortix-ld-live-'));
    // alpine's busybox build here has no `httpd` applet and no python3 — the
    // smallest possible HTTP stand-in that needs NOTHING beyond what's
    // already in the base image is a `nc`-in-a-loop responder that always
    // answers with whatever is currently in /www/current.txt, ignoring the
    // request path (path-based routing is irrelevant to what this test
    // verifies: that writes persist across stop/start and are reachable).
    await writeFile(
      join(buildContextDir, 'Dockerfile'),
      [
        'FROM alpine:latest',
        'RUN mkdir -p /www && echo "kortix-local-docker-live-test-boot" > /www/current.txt',
        'EXPOSE 8000',
        'CMD ["sh", "-c", "while true; do { printf \'HTTP/1.1 200 OK\\r\\nContent-Type: text/plain\\r\\nConnection: close\\r\\n\\r\\n\'; cat /www/current.txt; } | nc -l -p 8000; done"]',
        '',
      ].join('\n'),
    );
    const stream = await docker.buildImage(
      { context: buildContextDir, src: ['Dockerfile'] },
      { t: TEST_IMAGE },
    );
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  }, 60_000);

  afterAll(async () => {
    for (const id of createdExternalIds) {
      await docker.getContainer(`kortix-sb-${id}`).remove({ force: true, v: true }).catch(() => {});
    }
    await docker.getImage(TEST_IMAGE).remove({ force: true }).catch(() => {});
    await docker.getNetwork(TEST_NETWORK).remove().catch(() => {});
    await rm(buildContextDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  test('create → write a file → stop (preserved) → start (resume) → file persisted → remove (gone)', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create({
      accountId: 'live-acct',
      userId: 'live-user',
      name: 'live-session-1',
      snapshot: TEST_IMAGE,
      envVars: { KORTIX_SANDBOX_TOKEN: 'live-test-token' },
    });
    createdExternalIds.push(externalId);

    expect(await provider.getStatus(externalId)).toBe('running');

    // Write a file INSIDE the running container via docker exec (simulating
    // an agent leaving state in the workspace).
    const container = docker.getContainer(`kortix-sb-${externalId}`);
    const exec = await container.exec({
      Cmd: ['sh', '-c', 'echo -n "persisted-content" > /www/current.txt'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const execStream = await exec.start({});
    await new Promise<void>((resolve, reject) => {
      execStream.on('end', () => resolve());
      execStream.on('error', reject);
      execStream.resume();
    });

    // Reachability via the published debug port (this test process runs on
    // the host, not on the Docker network — see local-docker.ts's comment on
    // why the provider always ALSO publishes the agent port to loopback).
    // Re-inspect on every read rather than capturing the port once: Docker
    // Desktop reassigns a NEW ephemeral host port (HostPort: '0') on every
    // `docker start` of an existing container — the mapping is stable while
    // running but is NOT guaranteed stable across a stop/start cycle. This is
    // exactly why the provider's real (non-debug) path — resolveIngress/
    // resolveEndpoint — never uses the published port at all; it always
    // addresses the container by its stable Docker-network DNS name instead.
    const readFile = async () => {
      try {
        const inspected = await container.inspect();
        const hostPort = inspected.NetworkSettings?.Ports?.['8000/tcp']?.[0]?.HostPort;
        if (!hostPort) return null;
        // Each connection is served once by the nc-in-a-loop stand-in (see the
        // Dockerfile above) and a fresh connection can race the loop
        // respawning its listener — swallow a transient connection failure
        // and retry via waitFor rather than treating it as absent content.
        const res = await fetch(`http://127.0.0.1:${hostPort}/`);
        return res.ok ? res.text() : null;
      } catch {
        return null;
      }
    };
    expect(await waitFor(readFile, (v) => v === 'persisted-content')).toBe('persisted-content');

    // ── stop(): status flips to stopped, container is PRESERVED (not removed) ──
    await provider.stop(externalId);
    expect(await provider.getStatus(externalId)).toBe('stopped');
    await expect(container.inspect()).resolves.toBeTruthy(); // still exists

    // ── start(): resumes; the file written before stop is still there ──
    await provider.start(externalId);
    expect(await provider.getStatus(externalId)).toBe('running');
    expect(await waitFor(readFile, (v) => v === 'persisted-content')).toBe('persisted-content');

    // ── ingress resolution: the container is reachable by its Docker network
    // DNS name from ANOTHER container on the same network — the real
    // production path (kortix-api and every sandbox share this network) ──
    const ingress = await provider.resolveIngress(externalId, { port: 8000 });
    expect(ingress.url).toBe(`http://kortix-sb-${externalId}:8000`);
    const prober = await docker.createContainer({
      Image: TEST_IMAGE,
      Cmd: ['wget', '-qO-', `http://kortix-sb-${externalId}:8000/`],
      HostConfig: { NetworkMode: TEST_NETWORK },
    });
    await prober.start();
    await prober.wait();
    const logs = (await prober.logs({ stdout: true, stderr: true })) as unknown as Buffer;
    await prober.remove({ force: true }).catch(() => {});
    expect(logs.toString('utf8')).toContain('persisted-content');

    // ── remove(): container is actually gone ──
    await provider.remove(externalId);
    expect(await provider.getStatus(externalId)).toBe('removed');
    await expect(container.inspect()).rejects.toBeTruthy();
  }, 60_000);

  test('getStatus() tracks reality when the container is stopped EXTERNALLY (not through the provider)', async () => {
    const provider = new LocalDockerProvider();
    const { externalId } = await provider.create({
      accountId: 'live-acct',
      userId: 'live-user',
      name: 'live-session-external-stop',
      snapshot: TEST_IMAGE,
      envVars: { KORTIX_SANDBOX_TOKEN: 'live-test-token' },
    });
    createdExternalIds.push(externalId);
    expect(await provider.getStatus(externalId)).toBe('running');

    // Stop it directly via raw dockerode — an operator running `docker stop`
    // by hand, completely outside the provider's own bookkeeping.
    await docker.getContainer(`kortix-sb-${externalId}`).stop();
    expect(await provider.getStatus(externalId)).toBe('stopped');

    await provider.remove(externalId);
  }, 30_000);

  test('listManagedRunningSandboxes() is label-scoped across two concurrent sandboxes', async () => {
    const provider = new LocalDockerProvider();
    const a = await provider.create({
      accountId: 'live-acct', userId: 'live-user', name: 'live-a',
      snapshot: TEST_IMAGE, envVars: { KORTIX_SANDBOX_TOKEN: 'tok-a' },
    });
    const b = await provider.create({
      accountId: 'live-acct', userId: 'live-user', name: 'live-b',
      snapshot: TEST_IMAGE, envVars: { KORTIX_SANDBOX_TOKEN: 'tok-b' },
    });
    createdExternalIds.push(a.externalId, b.externalId);

    const runningBoth = await provider.listManagedRunningSandboxes!();
    const ids = runningBoth.map((x) => x.externalId);
    expect(ids).toContain(a.externalId);
    expect(ids).toContain(b.externalId);

    await provider.stop(b.externalId);
    const runningOne = await provider.listManagedRunningSandboxes!();
    expect(runningOne.map((x) => x.externalId)).toContain(a.externalId);
    expect(runningOne.map((x) => x.externalId)).not.toContain(b.externalId);

    await provider.remove(a.externalId);
    await provider.remove(b.externalId);
  }, 45_000);
});
