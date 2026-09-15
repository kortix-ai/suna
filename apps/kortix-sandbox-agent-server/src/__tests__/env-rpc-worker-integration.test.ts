import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

import type { Config } from '../config';
import type { Opencode } from '../opencode';
import { startProxy } from '../proxy';
import { createEnvRpcRouter } from '../routes/env-rpc';
// The worker half, imported from its real sources. `ws` loads lazily, so the
// HTTP-only test does not create a socket as an import side effect.
import { KortixExecutionEnv } from '../../../kortix-worker/src/kortix-env.ts';
import { LazyKortixEnv, mintUserContext } from '../../../kortix-worker/src/lazy-env.ts';
import { mintRootId } from '../../../kortix-worker/src/runtime-surface.ts';
import { startWorker } from '../../../kortix-worker/src/worker.ts';

const WORKER_TOKEN = 'worker-session-token';
const ENVIRONMENT_TOKEN = 'environment-session-token';
const RPC_SECRET = 'purpose-bound-environment-rpc-secret';

interface Rig {
  stop(): Promise<void>;
  ensureCalls: number;
  workspace: string;
  env: LazyKortixEnv;
}

function proxyConfig(workspace: string): Config {
  return {
    servicePort: 0,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace,
    projectTarget: workspace,
    defaultBranch: 'main',
    branchFetchAttempts: 1,
    branchFetchDelaySec: 0.01,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    compiledBootMode: 'off',
    sandboxToken: ENVIRONMENT_TOKEN,
    envRpcSecret: RPC_SECRET,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
  };
}

function fakeOpencode(): Opencode {
  return {
    getState: () => 'ok',
    getPid: () => null,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
  } as unknown as Opencode;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('condition did not become true before timeout');
}

/**
 * The whole P1.7 wire, end to end and real on both halves:
 *
 *   worker LazyKortixEnv ──ensure──▶ fake Kortix API (counts calls)
 *                        ──ops────▶ REAL daemon env-rpc router (real fs, real bash)
 *
 * The daemon router verifies the X-Kortix-User-Context signature, so a green
 * op also proves the worker's own header minting against the daemon's codec.
 */
async function buildRig(historyEnabled = false): Promise<Rig> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-env-ws-'));

  const daemon = new Hono();
  daemon.get('/kortix/health', (c) =>
    c.json({
      ok: true,
      repo_ready: true,
      workload: 'environment',
      opencode: 'disabled',
      runtimeReady: true,
    }),
  );
  daemon.route(
    '/kortix/env-rpc',
    createEnvRpcRouter({
      sandboxToken: ENVIRONMENT_TOKEN,
      envRpcSecret: RPC_SECRET,
      workspace,
      workload: 'environment',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      environmentHistory: historyEnabled,
      agentStateDir: workspace + '-state',
    } as unknown as Config),
  );
  const daemonServer = Bun.serve({ port: 0, fetch: daemon.fetch });

  const rig = { ensureCalls: 0 } as Rig;
  const api = new Hono();
  api.get('/v1/projects/:pid/sessions/:sid/environment', c => c.json({ external_id: 'env-box-1', status: 'active' }));
  api.post('/v1/projects/:pid/sessions/:sid/environment/ensure', (c) => {
    rig.ensureCalls += 1;
    if (c.req.header('authorization') !== `Bearer ${WORKER_TOKEN}`) {
      return c.json({ error: 'bad token' }, 401);
    }
    return c.json({
      session_id: c.req.param('sid'),
      status: 'active',
      external_id: 'env-box-1',
      preview_url: `http://127.0.0.1:${daemonServer.port}`,
      preview_token: 'edge-token',
      rpc_secret: RPC_SECRET,
    });
  });
  const apiServer = Bun.serve({ port: 0, fetch: api.fetch });

  rig.workspace = workspace;
  rig.env = new LazyKortixEnv({
    apiUrl: `http://127.0.0.1:${apiServer.port}/v1`,
    token: WORKER_TOKEN,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    cwd: workspace,
    ensureTimeoutMs: 10_000,
  });
  rig.stop = async () => {
    await rig.env.cleanup();
    daemonServer.stop(true);
    apiServer.stop(true);
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(workspace + '-state', { recursive: true, force: true });
  };
  return rig;
}

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.stop();
  rig = null;
});

describe('worker lazy environment ↔ daemon env-rpc', () => {
  test.each(['fetch', 'keepalive', 'ws', 'auto'] as const)(
    '%s cancels remote execution when an output callback fails',
    async (transport) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-progress-failure-'));
      const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
      const env = new KortixExecutionEnv({
        baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
        cwd: workspace,
        headers: { 'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-progress-failure') },
        transport,
      });
      const chunks: string[] = [];
      try {
        const result = await env.exec(
          "echo $$ > leader.pid; printf 'EARLY'; (sleep 0.5; touch forbidden; printf 'LATE') & wait",
          {
            onStdout: (chunk) => {
              chunks.push(chunk);
              throw new Error('consumer failed');
            },
          },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain('consumer failed');
        const pid = Number(await fs.readFile(path.join(workspace, 'leader.pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
        await Bun.sleep(600);
        expect(await fs.stat(path.join(workspace, 'forbidden')).catch(() => null)).toBeNull();
        expect(chunks).toEqual(['EARLY']);
      } finally {
        await env.cleanup();
        proxy.stop();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );

  test('WebSocket progress stays isolated when one of two concurrent commands stops', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-progress-concurrent-'));
    const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
    const env = new KortixExecutionEnv({
      baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
      cwd: workspace,
      headers: { 'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-concurrent') },
      transport: 'ws',
    });
    const controller = new AbortController();
    const first: string[] = [];
    const second: string[] = [];
    const stopped = env.exec(
      "printf 'FIRST'; while [ ! -f release ]; do sleep 0.01; done; touch forbidden",
      {
        abortSignal: controller.signal,
        onStdout: (chunk) => {
          first.push(chunk);
        },
      },
    );
    const completed = env.exec(
      "printf 'SECOND'; while [ ! -f release ]; do sleep 0.01; done; printf ' DONE'; exit 7",
      {
        onStdout: (chunk) => {
          second.push(chunk);
        },
      },
    );
    try {
      await waitUntil(() => first.length > 0 && second.length > 0);
      controller.abort();
      const result = await stopped;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('aborted');
      await fs.writeFile(path.join(workspace, 'release'), '');
      expect(await completed).toEqual({
        ok: true,
        value: { stdout: 'SECOND DONE', stderr: '', exitCode: 7 },
      });
      expect(first.join('')).toBe('FIRST');
      expect(second.join('')).toBe('SECOND DONE');
      expect(await fs.stat(path.join(workspace, 'forbidden')).catch(() => null)).toBeNull();
    } finally {
      controller.abort();
      await fs.writeFile(path.join(workspace, 'release'), '');
      await Promise.all([stopped, completed]);
      await env.cleanup();
      proxy.stop();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test('streamed output retains the existing cap and emits the truncation suffix once', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-progress-cap-'));
    const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
    const env = new KortixExecutionEnv({
      baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
      cwd: workspace,
      headers: { 'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-cap') },
      transport: 'fetch',
    });
    const chunks: string[] = [];
    try {
      const result = await env.exec("head -c 2097153 /dev/zero | tr '\\0' x", {
        onStdout: (chunk) => {
          chunks.push(chunk);
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stdout).toBe('x'.repeat(2097152) + '\n[output truncated at 2MiB]');
        expect(chunks.join('')).toBe(result.value.stdout);
      }
    } finally {
      await env.cleanup();
      proxy.stop();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  test.each(['fetch', 'keepalive', 'ws', 'auto'] as const)(
    '%s emits stdout and stderr before exit without duplicating final output',
    async (transport) => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-progress-'));
      const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
      const env = new KortixExecutionEnv({
        baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
        cwd: workspace,
        headers: { 'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-progress') },
        transport,
      });
      const controller = new AbortController();
      let first!: () => void;
      const early = new Promise<void>((resolve) => {
        first = resolve;
      });
      const stdout: string[] = [];
      const stderr: string[] = [];
      let settled = false;
      const operation = env
        .exec(
          "printf 'FIRST\\n'; printf 'ERR\\n' >&2; while [ ! -f release ]; do sleep 0.01; done; printf '\\360\\237'; sleep 0.02; printf '\\230\\200\\n'",
          {
            abortSignal: controller.signal,
            onStdout: (value) => {
              stdout.push(value);
              first();
            },
            onStderr: (value) => {
              stderr.push(value);
            },
          },
        )
        .then((result) => {
          settled = true;
          return result;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          early,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('No output before command exit')), 2000);
          }),
        ]);
        expect(settled).toBe(false);
        expect(stdout.join('')).toBe('FIRST\n');
        await fs.writeFile(path.join(workspace, 'release'), '');
        expect(await operation).toEqual({
          ok: true,
          value: { stdout: 'FIRST\n😀\n', stderr: 'ERR\n', exitCode: 0 },
        });
        expect(stdout.join('')).toBe('FIRST\n😀\n');
        expect(stderr.join('')).toBe('ERR\n');
      } finally {
        clearTimeout(timer);
        controller.abort();
        await operation;
        await env.cleanup();
        proxy.stop();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    },
  );

  for (const transport of ['fetch', 'keepalive', 'ws'] as const) {
    test(`Stop cancels a remote ${transport} command before delayed side effects`, async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `worker-stop-${transport}-`));
      const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
      const sessionId = `remote-stop-${transport}`;
      const marker = path.join(workspace, 'late-marker.txt');
      const pidFile = path.join(workspace, 'leader.pid');
      const worker = await startWorker({
        port: 0,
        envUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
        envUrlExplicit: true,
        envCwd: workspace,
        envHeaders: {
          'x-kortix-user-context': mintUserContext(RPC_SECRET, `env-box-${transport}`),
        },
        envTransport: transport,
        systemPrompt: 'Run the requested command.',
        modelMode: 'faux',
        sessionId,
        kortixToken: WORKER_TOKEN,
        turnAbortPollMs: 5,
      });
      const prompt = fetch(`http://127.0.0.1:${worker.port}/prompt`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          text: 'Run the command.',
          script: [
            {
              tool: 'bash',
              args: {
                command: `echo $$ > ${JSON.stringify(pidFile)}; (sleep 1; echo late > ${JSON.stringify(marker)}) & wait`,
              },
            },
            { text: 'must not run' },
          ],
        }),
      });

      try {
        const deadline = Date.now() + 2_000;
        while (!(await fs.stat(pidFile).catch(() => null))) {
          if (Date.now() >= deadline) throw new Error('remote command did not start');
          await Bun.sleep(5);
        }
        const pid = Number(await fs.readFile(pidFile, 'utf8'));
        const stopStartedAt = Date.now();
        const stopped = await fetch(
          `http://127.0.0.1:${worker.port}/session/${mintRootId(sessionId)}/abort`,
          { method: 'POST', headers: { authorization: `Bearer ${WORKER_TOKEN}` } },
        );

        expect(stopped.status).toBe(200);
        expect(Date.now() - stopStartedAt).toBeLessThan(700);
        expect(() => process.kill(pid, 0)).toThrow();
        expect((await prompt).status).toBe(200);
        await Bun.sleep(1_100);
        expect(await fs.stat(marker).catch(() => null)).toBeNull();
        expect(JSON.stringify(worker.agent.state.messages)).not.toContain('must not run');
      } finally {
        await worker.env.cleanup();
        await worker.close();
        await proxy.stop();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    }, 10_000);
  }

  for (const transport of ['fetch', 'keepalive', 'ws'] as const) {
    test(`worker RPC timeout cancels an authenticated remote ${transport} command`, async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `worker-timeout-${transport}-`));
      const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
      const marker = path.join(workspace, 'timeout-marker.txt');
      const pidFile = path.join(workspace, 'timeout.pid');
      const env = new KortixExecutionEnv({
        baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
        cwd: workspace,
        headers: {
          'x-kortix-user-context': mintUserContext(RPC_SECRET, `env-box-timeout-${transport}`),
        },
        transport,
        timeoutMs: 500,
      });
      const run = env.exec(
        `echo $$ > ${JSON.stringify(pidFile)}; (sleep 0.9; echo late > ${JSON.stringify(marker)}) & wait`,
        { timeout: 5 },
      );

      try {
        const deadline = Date.now() + 1_000;
        while (!(await fs.stat(pidFile).catch(() => null))) {
          if (Date.now() >= deadline) throw new Error('remote command did not start');
          await Bun.sleep(5);
        }
        const pid = Number(await fs.readFile(pidFile, 'utf8'));
        const result = await run;

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected timeout failure');
        expect(result.error.code).toBe('unknown');
        expect(result.error.message).toBe('rpc timeout');
        await env.waitForAbortSettled();
        expect(() => process.kill(pid, 0)).toThrow();
        await Bun.sleep(600);
        expect(await fs.stat(marker).catch(() => null)).toBeNull();
      } finally {
        await env.cleanup();
        await proxy.stop();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    }, 10_000);
  }

  test('closing an env-rpc websocket cancels its remote process group', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-ws-close-'));
    const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
    const marker = path.join(workspace, 'socket-close-marker.txt');
    const pidFile = path.join(workspace, 'socket-close.pid');
    const env = new KortixExecutionEnv({
      baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
      cwd: workspace,
      headers: {
        'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-box-ws-close'),
      },
      transport: 'ws',
    });
    const run = env.exec(
      `echo $$ > ${JSON.stringify(pidFile)}; (sleep 0.8; echo late > ${JSON.stringify(marker)}) & wait`,
    );

    try {
      while (!(await fs.stat(pidFile).catch(() => null))) await Bun.sleep(5);
      const pid = Number(await fs.readFile(pidFile, 'utf8'));
      await env.cleanup();
      expect((await run).ok).toBe(false);
      const deadline = Date.now() + 600;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(5);
        } catch {
          break;
        }
      }
      expect(() => process.kill(pid, 0)).toThrow();
      await Bun.sleep(900);
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
    } finally {
      await env.cleanup();
      await proxy.stop();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 5_000);

  test('one real websocket carries multiple remote file operations and closes on cleanup', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-env-ws-'));
    const proxy = startProxy(proxyConfig(workspace), fakeOpencode(), Date.now());
    const env = new KortixExecutionEnv({
      baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`,
      cwd: workspace,
      headers: {
        'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-box-ws'),
      },
      transport: 'ws',
      timeoutMs: 5_000,
    });
    const transport = (
      env as unknown as {
        transport: { kind: string; ws?: { readyState: number } };
      }
    ).transport;

    try {
      expect(transport.kind).toBe('ws');
      expect(transport.ws).toBeUndefined();

      expect(await env.writeFile('remote/answer.txt', '42\n')).toEqual({
        ok: true,
        value: undefined,
      });
      const socket = transport.ws;
      expect(socket?.readyState).toBe(1);

      expect(await env.readTextFile('remote/answer.txt')).toEqual({
        ok: true,
        value: '42\n',
      });
      expect(transport.ws).toBe(socket);
      expect(env.calls.map(({ op }) => op)).toEqual(['writeFile', 'readTextFile']);
      expect(await fs.readFile(path.join(workspace, 'remote/answer.txt'), 'utf8')).toBe('42\n');

      await env.cleanup();
      await waitUntil(() => socket?.readyState === 3);
    } finally {
      await env.cleanup();
      await proxy.stop();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);

  test('zero provisioning before the first operation; one ensure for many ops', async () => {
    rig = await buildRig();
    expect(rig.ensureCalls).toBe(0);
    expect(rig.env.attached).toBe(false);

    const write = await rig.env.writeFile('src/app.ts', 'export const answer = 42\n');
    expect(write.ok).toBe(true);
    expect(rig.ensureCalls).toBe(1);
    expect(rig.env.attached).toBe(true);
    expect(rig.env.externalId).toBe('env-box-1');

    // Real bytes on the environment's real filesystem.
    const onDisk = await fs.readFile(path.join(rig.workspace, 'src/app.ts'), 'utf8');
    expect(onDisk).toBe('export const answer = 42\n');

    // Later ops reuse the attachment — no second ensure.
    const read = await rig.env.readTextFile('src/app.ts');
    expect(read).toEqual({ ok: true, value: 'export const answer = 42\n' });
    const run = await rig.env.exec('grep -r answer src && echo FOUND');
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.value.stdout).toContain('FOUND');
      expect(run.value.exitCode).toBe(0);
    }
    expect(rig.ensureCalls).toBe(1);
    // The rpcCalls tap the worker's /say reports.
    expect(rig.env.calls.map((c) => c.op)).toEqual(['writeFile', 'readTextFile', 'exec']);
  });

  test('a pre-aborted lazy mutation does not provision or reach the environment', async () => {
    rig = await buildRig();
    const controller = new AbortController();
    controller.abort();

    const result = await rig.env.writeFile('must-not-exist.txt', 'late', controller.signal);

    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as { code?: string }).code).toBe('aborted');
    expect(rig.ensureCalls).toBe(0);
    expect(
      await fs.stat(path.join(rig.workspace, 'must-not-exist.txt')).catch(() => null),
    ).toBeNull();
  });

  test('the lazy production environment forwards cancellation without replaying exec', async () => {
    rig = await buildRig();
    const marker = path.join(rig.workspace, 'lazy-marker.txt');
    const pidFile = path.join(rig.workspace, 'lazy.pid');
    const controller = new AbortController();
    const run = rig.env.exec(
      `echo $$ > ${JSON.stringify(pidFile)}; (sleep 0.8; echo late > ${JSON.stringify(marker)}) & wait`,
      { abortSignal: controller.signal },
    );
    while (!(await fs.stat(pidFile).catch(() => null))) await Bun.sleep(5);
    const pid = Number(await fs.readFile(pidFile, 'utf8'));

    controller.abort();
    await rig.env.waitForAbortSettled();

    const result = await run;
    expect(result.ok).toBe(false);
    if (!result.ok) expect((result.error as { code?: string }).code).toBe('aborted');
    expect(() => process.kill(pid, 0)).toThrow();
    await Bun.sleep(900);
    expect(await fs.stat(marker).catch(() => null)).toBeNull();
    expect(rig.ensureCalls).toBe(1);
  }, 5_000);

  test('a missing file is a Result the tool can render, and a dead API is too', async () => {
    rig = await buildRig();
    const missing = await rig.env.readTextFile('never-written.txt');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect((missing.error as { code?: string }).code).toBe('not_found');

    const dead = new LazyKortixEnv({
      apiUrl: 'http://127.0.0.1:1/v1',
      token: WORKER_TOKEN,
      projectId: 'p',
      sessionId: 's',
      cwd: '/workspace',
      ensureTimeoutMs: 1500,
    });
    const result = await dead.exec('echo hi');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(String((result.error as Error).message)).toContain('could not attach environment');
    }
  }, 15_000);

  test('the real worker edit tool reads and writes through the daemon', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-edit-rpc-'));
    const target = path.join(workspace, 'src/app.ts');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'export const answer = 41\n');

    const daemon = new Hono();
    daemon.route(
      '/kortix/env-rpc',
      createEnvRpcRouter({
        sandboxToken: ENVIRONMENT_TOKEN,
        envRpcSecret: RPC_SECRET,
        workspace,
      } as unknown as Config),
    );
    const daemonServer = Bun.serve({ port: 0, fetch: daemon.fetch });
    const worker = await startWorker({
      port: 0,
      envUrl: `http://127.0.0.1:${daemonServer.port}/kortix/env-rpc`,
      envUrlExplicit: true,
      envCwd: workspace,
      envHeaders: {
        'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-box-edit'),
      },
      envTransport: 'fetch',
      systemPrompt: 'Edit the requested file.',
      modelMode: 'faux',
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    });

    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'Change the answer to 42.',
          script: [
            {
              tool: 'edit',
              args: {
                path: 'src/app.ts',
                edits: [{ oldText: 'answer = 41', newText: 'answer = 42' }],
              },
            },
            { text: 'done' },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { rpcCalls?: string[] };
      expect(body.rpcCalls).toEqual([
        'absolutePath',
        'absolutePath',
        'canonicalPath',
        'fileInfo',
        'readTextFile',
        'writeFile',
      ]);
      expect(await fs.readFile(target, 'utf8')).toBe('export const answer = 42\n');
    } finally {
      await worker.env.cleanup();
      await worker.close();
      daemonServer.stop(true);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 15_000);
});


test.each(['fetch', 'keepalive', 'ws', 'auto'] as const)('%s checkpoints cross the real worker/daemon boundary', async transport => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-history-'));
  const cfg = { ...proxyConfig(workspace), workload: 'environment', projectId: 'p', sessionId: 's', environmentHistory: true, agentStateDir: workspace + '-state' };
  const proxy = startProxy(cfg, fakeOpencode(), Date.now());
  const env = new KortixExecutionEnv({ baseUrl: `http://127.0.0.1:${proxy.port}/kortix/env-rpc`, cwd: workspace, headers: { 'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-history') }, transport });
  try {
    expect((await env.writeFile('a', 'before')).ok).toBe(true);
    const before = await env.captureWorkspace(crypto.randomUUID());
    if (!before.ok) throw before.error;
    expect((await env.writeFile('a', 'after')).ok).toBe(true);
    const after = await env.captureWorkspace(crypto.randomUUID());
    if (!after.ok) throw after.error;
    const move = { operationId: crypto.randomUUID(), from: after.value.snapshotId, to: before.value.snapshotId };
    expect(await env.applyWorkspace(move)).toMatchObject({ ok: true, value: { status: 'complete', changedPaths: ['a'] } });
    expect(await fs.readFile(path.join(workspace, 'a'), 'utf8')).toBe('before');
    expect(await env.pendingWorkspace()).toEqual({ ok: true, value: null });
    expect(await env.applyWorkspace(move)).toMatchObject({ ok: true, value: { status: 'complete' } });
    expect((await env.applyWorkspace({ ...move, operationId: 'invalid' })).ok).toBe(false);
  } finally {
    await env.cleanup();
    proxy.stop();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(workspace + '-state', { recursive: true, force: true });
  }
});

test('lazy history methods attach only on explicit use and return transport results', async () => {
  rig = await buildRig(true);
  expect(rig.ensureCalls).toBe(0);
  expect(rig.env.attached).toBe(false);
  const before = await rig.env.captureWorkspace(crypto.randomUUID());
  if (!before.ok) throw before.error;
  expect(rig.ensureCalls).toBe(1);
  expect((await rig.env.writeFile('a', 'after')).ok).toBe(true);
  const after = await rig.env.captureWorkspace(crypto.randomUUID());
  if (!after.ok) throw after.error;
  expect(await rig.env.applyWorkspace({ operationId: crypto.randomUUID(), from: after.value.snapshotId, to: before.value.snapshotId })).toMatchObject({ ok: true, value: { status: 'complete' } });
  expect(await fs.stat(path.join(rig.workspace, 'a')).catch(() => null)).toBeNull();
  expect(await rig.env.pendingWorkspace()).toEqual({ ok: true, value: null });
  expect(rig.ensureCalls).toBe(1);
});

test.each(['write', 'bash', 'custom'])('real worker %s rewind coordinates history, files, conflicts, restore and replacement', async mode => {
  const globals = globalThis as any;
  const priorFactory = globals.__KORTIX_PI_AGENT__;
  if (mode === 'custom') globals.__KORTIX_PI_AGENT__ = (ctx: any) => ({ tools: [{ name: 'custom_write', label: 'Custom write', description: 'Write the report', parameters: { type: 'object', properties: {} }, execute: async () => { const results = await Promise.all([ctx.env.writeFile('report', 'after'), ctx.env.writeFile('parallel', 'custom')]); for (const result of results) if (!result.ok) throw result.error; return { content: [{ type: 'text', text: 'saved' }] }; } }] });
  const { validatePiHistoryControlAppend, projectPiHistory } = await import('../../../../packages/shared/src/pi-history');
  const rig = await buildRig(true);
  const items: any[] = [];
  const store = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') return Response.json(items);
    const item = await request.json();
    const prior = items.find(row => row._kortixAppendId === item._kortixAppendId);
    if (prior) return new Response(null, { status: JSON.stringify(prior) === JSON.stringify(item) ? 204 : 409 });
    try { validatePiHistoryControlAppend(items, item); }
    catch (error) { return Response.json({ error: String(error) }, { status: 409 }); }
    items.push(item);
    return new Response(null, { status: 204 });
  } });
  const config = {
    port: 0, envUrl: 'http://unused', envCwd: rig.workspace, systemPrompt: 'Follow the user.',
    modelMode: 'faux' as const, sessionId: 'sess-1', projectId: 'proj-1',
    fauxScript: [{ tool: mode === 'custom' ? 'custom_write' : mode, args: mode === 'bash' ? { command: 'printf after > report; printf streaming-output' } : { path: 'report', content: 'after' } }, { text: 'Saved report.' }],
    kortixToken: WORKER_TOKEN, storeUrl: store.url.toString().replace(/\/$/, ''),
    apiUrl: (rig.env as any).opts.apiUrl,
  };
  let worker = await startWorker(config);
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${worker.port}${path}`, {
    headers: { authorization: `Bearer ${WORKER_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  });
  const id = (await (await request('/session')).json())[0].id;
  const history = async () => (await request(`/session/${id}/message`)).json() as Promise<any[]>;
  const restart = async () => { worker.server.closeAllConnections(); await worker.close(); worker = await startWorker(config); };
  try {
    await fs.writeFile(path.join(rig.workspace, 'report'), 'before');
    expect((await request(`/session/${id}/message`, { parts: [{ type: 'text', text: 'Update report.' }] })).status).toBe(200);
    expect(await fs.readFile(path.join(rig.workspace, 'report'), 'utf8')).toBe('after');
    const original = await history();
    const user = original.find(message => message.info.role === 'user').info.id;
    await fs.writeFile(path.join(rig.workspace, 'manual'), 'preserve');
    await fs.writeFile(path.join(rig.workspace, 'report'), 'manual conflict');
    const conflict = await request(`/session/${id}/revert`, { messageID: user });
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toContain('conflict');
    expect(await history()).toEqual(original);
    expect(projectPiHistory(items).pending).toBeNull();
    await fs.writeFile(path.join(rig.workspace, 'report'), 'after');
    const rewind = await request(`/session/${id}/revert`, { messageID: user });
    const result = await rewind.json();
    expect(result).toMatchObject({ revert: { messageID: user } });
    expect(rewind.status).toBe(200);
    expect(await history()).toEqual([]);
    expect(await fs.readFile(path.join(rig.workspace, 'report'), 'utf8')).toBe('before');
    expect(await fs.readFile(path.join(rig.workspace, 'manual'), 'utf8')).toBe('preserve');
    await restart();
    expect(await history()).toEqual([]);
    expect((await request(`/session/${id}/unrevert`, {})).status).toBe(200);
    expect(await history()).toEqual(original);
    expect(await fs.readFile(path.join(rig.workspace, 'report'), 'utf8')).toBe('after');
    expect(await fs.readFile(path.join(rig.workspace, 'manual'), 'utf8')).toBe('preserve');
  } finally { worker.server.closeAllConnections(); await worker.close(); store.stop(true); await rig.stop(); globals.__KORTIX_PI_AGENT__ = priorFactory; }
}, 20000);

test.each(['fetch', 'keepalive', 'ws', 'auto'] as const)('%s runs local MCP in the environment, tracks unsafe rewind, and settles Stop', async transport => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rpc-mcp-'));
  const cfg = { ...proxyConfig(workspace), workload: 'environment', projectId: 'p', sessionId: 's', environmentHistory: true, agentStateDir: workspace + '-state' };
  const proxy = startProxy(cfg, fakeOpencode(), Date.now());
  const journal: any[] = [];
  const baseUrl = `http://127.0.0.1:${proxy.port}/kortix/env-rpc`;
  const env = new KortixExecutionEnv({ baseUrl, cwd: workspace, headers: { 'x-kortix-user-context': mintUserContext(RPC_SECRET, 'env-mcp') }, transport, observeWorkspace: async event => { journal.push(event); return true; } });
  const configuration = { type: 'local' as const, command: [process.execPath, path.join(import.meta.dir, 'fixtures/stdio-mcp-server.mjs')] };
  let connectionId = '';
  try {
    expect((await fetch(baseUrl, { method: 'POST', body: JSON.stringify({ op: 'mcpRequest', args: { server: 'fixture', configuration, method: 'tools/list' } }) })).status).toBe(401);
    const first = await env.mcpRequest({ server: 'fixture', configuration, method: 'tools/list' });
    if (!first.ok) throw first.error;
    connectionId = first.value.connectionId;
    expect(first.value.result).toMatchObject({ tools: [{ name: 'counter' }] });
    expect(await env.captureWorkspace(crypto.randomUUID())).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(journal).toMatchObject([{ phase: 'begin' }, { phase: 'end', workspace: null }]);
    const written = await env.mcpRequest({ server: 'fixture', configuration, connectionId, method: 'tools/call', params: { name: 'write', arguments: { path: 'mcp-file', text: 'MCP_OK' } } });
    expect(written.ok).toBe(true);
    expect(await fs.readFile(path.join(workspace, 'mcp-file'), 'utf8')).toBe('MCP_OK');
    const controller = new AbortController();
    const running = env.mcpRequest({ server: 'fixture', configuration, connectionId, method: 'tools/call', params: { name: 'sleep' } }, controller.signal);
    await waitUntil(() => Bun.file(path.join(workspace, 'started')).size > 0);
    controller.abort();
    expect((await running).ok).toBe(false);
    const pid = Number(await fs.readFile(path.join(workspace, 'started'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await env.captureWorkspace(crypto.randomUUID())).ok).toBe(true);
    expect(await fs.stat(path.join(workspace, 'late')).catch(() => null)).toBeNull();
    expect((await env.mcpRequest({ server: 'fixture', configuration, connectionId, method: 'tools/call', params: { name: 'counter' } })).ok).toBe(false);
    expect(journal.filter(event => event.phase === 'end').every(event => event.workspace === null)).toBe(true);
  } finally {
    if (connectionId) await env.mcpDisconnect('fixture', connectionId);
    await env.cleanup(); proxy.stop();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(workspace + '-state', { recursive: true, force: true });
  }
});

test('configured MCP allocates the lazy environment only on discovery and reuses it', async () => {
  rig = await buildRig(true);
  expect(rig.ensureCalls).toBe(0);
  const configuration = { type: 'local' as const, command: [process.execPath, path.join(import.meta.dir, 'fixtures/stdio-mcp-server.mjs')] };
  const discovered = await rig.env.mcpRequest({ server: 'fixture', configuration, method: 'tools/list' });
  if (!discovered.ok) throw discovered.error;
  try {
    expect(rig.ensureCalls).toBe(1);
    const result = await rig.env.mcpRequest({ server: 'fixture', configuration, connectionId: discovered.value.connectionId, method: 'tools/call', params: { name: 'counter' } });
    if (!result.ok) throw result.error;
    expect(JSON.parse((result.value.result as any).content[0].text)).toMatchObject({ count: 1 });
    expect(rig.ensureCalls).toBe(1);
  } finally { await rig.env.mcpDisconnect('fixture', discovered.value.connectionId); }
});

test.each(['mcpRequest', 'mcpDisconnect'] as const)('%s never repeats an ambiguous transport result', async operation => {
  let calls = 0;
  const server = Bun.serve({ port: 0, fetch() { calls++; return Response.json({ ok: false, error: { message: 'ECONNRESET: socket closed after side effect' } }); } });
  const env = new KortixExecutionEnv({ baseUrl: server.url.toString(), cwd: '/workspace', transport: 'fetch' });
  try {
    const response = operation === 'mcpDisconnect' ? await env.mcpDisconnect('fixture', 'connection') : await env.mcpRequest({ server: 'fixture', configuration: { type: 'local', command: ['node'] }, method: 'tools/list' });
    expect(response.ok).toBe(false);
    expect(calls).toBe(1);
  } finally { await env.cleanup(); server.stop(true); }
});
