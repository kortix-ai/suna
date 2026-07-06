/**
 * Boots the whitelabel-demo app as a real `next start` process for black-box
 * HTTP testing — no mocking of Next internals, the same binary that runs in
 * production. Builds once (memoized) if `.next` isn't already there, then
 * spawns `next start -p 0` (Next assigns a free port and prints it) per test
 * file that needs a live instance.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const APP_ROOT = join(import.meta.dir, '..', '..');
const NEXT_BIN = join(APP_ROOT, 'node_modules', '.bin', 'next');

/**
 * Per-test-run ownership store, NEVER the app dir's real `.lumen-data`.
 * Test instances boot with `LUMEN_DATA_DIR` pointing here (see `startApp`),
 * so running the suite can't wipe a developer's local wrapper state — which
 * is exactly what the original cwd-based store did.
 */
export const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'lumen-e2e-'));

let buildPromise: Promise<void> | null = null;

/** Build the app once (skipped if `.next/BUILD_ID` already exists). Memoized
 *  across every caller in this process so multiple test files sharing one
 *  `bun test` run don't rebuild redundantly. */
export function ensureBuilt(): Promise<void> {
  if (existsSync(join(APP_ROOT, '.next', 'BUILD_ID'))) return Promise.resolve();
  if (!buildPromise) {
    buildPromise = (async () => {
      const proc = Bun.spawn({
        cmd: [NEXT_BIN, 'build'],
        cwd: APP_ROOT,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      if (code !== 0) {
        throw new Error(`next build failed (exit ${code}):\n${stdout}\n${stderr}`);
      }
    })();
  }
  return buildPromise;
}

export interface AppInstance {
  baseUrl: string;
  /** Everything the process has printed so far — useful in failure messages. */
  log(): string;
  stop(): Promise<void>;
}

/** Remove the suite's per-user ownership JSON store (the temp
 *  `TEST_DATA_DIR`, never the app dir's real `.lumen-data`). Always call this
 *  before AND after a boot that will provision/own projects, so test files
 *  don't leak state into each other via the shared store. */
export function resetUsersStore(): void {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

/** A fresh, collision-free demo-login email for a single test. */
export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}+${randomUUID().slice(0, 8)}@example.test`;
}

/** Log in against a running app's `/api/auth/login` and return the bearer token. */
export async function loginUser(
  app: AppInstance,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${app.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

/**
 * Start `next start` with the given extra env (merged over `process.env`).
 * Resolves once the server has printed its bound URL AND actually answers an
 * HTTP request.
 */
export async function startApp(
  env: Record<string, string | undefined>,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<AppInstance> {
  await ensureBuilt();

  const proc = Bun.spawn({
    cmd: [NEXT_BIN, 'start', '-p', '0'],
    cwd: APP_ROOT,
    env: { ...process.env, LUMEN_DATA_DIR: TEST_DATA_DIR, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let log = '';
  const appendLog = async (stream: ReadableStream<Uint8Array> | null) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        log += decoder.decode(value, { stream: true });
      }
    } catch {
      // process died/stream closed — nothing more to drain
    }
  };
  const stdoutDrain = appendLog(proc.stdout);
  const stderrDrain = appendLog(proc.stderr);

  const exitedEarly = proc.exited.then(() => 'exited' as const);

  const deadline = Date.now() + timeoutMs;
  let baseUrl: string | null = null;
  while (!baseUrl) {
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`next start didn't print a URL within ${timeoutMs}ms. Output so far:\n${log}`);
    }
    const raced = await Promise.race([
      exitedEarly,
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 50)),
    ]);
    if (raced === 'exited') {
      throw new Error(`next start exited before printing a URL (code ${proc.exitCode}). Output:\n${log}`);
    }
    const m = log.match(/Local:\s+(http:\/\/localhost:\d+)/);
    if (m) baseUrl = m[1];
  }

  // The URL line can print a beat before the listener actually accepts
  // connections — poll until a real HTTP round-trip succeeds.
  const readyDeadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`${baseUrl}/api/mode`);
      break;
    } catch {
      if (Date.now() > readyDeadline) {
        proc.kill();
        throw new Error(`next start bound ${baseUrl} but never accepted a request. Output so far:\n${log}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return {
    baseUrl,
    log: () => log,
    async stop() {
      // SIGKILL, not the default SIGTERM: `next start`'s graceful shutdown
      // waits for Node's HTTP keep-alive sockets to drain (default
      // `keepAliveTimeout` 5s) before exiting — that stalls teardown for
      // every test that left an SSE/long-poll connection open (by design;
      // the client, not the server, ends those). These are disposable test
      // processes, so skip the grace period entirely.
      proc.kill('SIGKILL');
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 3_000))]);
      await Promise.allSettled([stdoutDrain, stderrDrain]);
    },
  };
}
