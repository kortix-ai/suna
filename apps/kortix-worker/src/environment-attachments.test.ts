import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../kortix-sandbox-agent-server/src/config';
import { installSessionAttachment } from '../../kortix-sandbox-agent-server/src/session-attachments';
import { sessionAttachmentPath } from '../../../packages/shared/src/session-attachment-path';
import { createEnvRpcRouter } from '../../kortix-sandbox-agent-server/src/routes/env-rpc';
import { mintUserContext } from './lazy-env';
import { startWorker } from './worker';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-documents-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const bytes = Buffer.from('name,total\nKortix,42\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const file = { sha256, mime: 'text/csv', filename: 'R&D <report>.csv' };
  const reads: string[] = [];
  const items: any[] = [];
  let body = bytes;
  let mime = file.mime;
  let gate: Promise<void> | undefined;
  const api = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.includes('/attachments/')) {
      expect(url.pathname).toBe(`/v1/projects/project/sessions/session/attachments/${sha256}`);
      reads.push(request.headers.get('authorization')!);
      if (gate) await gate;
      return new Response(body, { headers: { 'content-type': mime } });
    }
    if (request.method === 'GET') return Response.json(items);
    const item = await request.json();
    const id = request.headers.get('idempotency-key');
    if (!id || !items.some(row => row._kortixAppendId === id)) items.push(item);
    return new Response(null, { status: 204 });
  } });
  cleanup.push(() => api.stop(true));
  const cfg = { workspace, agentStateDir: path.join(root, 'state'), apiUrl: `${api.url}v1`, projectId: 'project', sessionId: 'session', sandboxToken: 'environment-token', envRpcSecret: 'rpc-secret', workload: 'environment', environmentHistory: true } as Config;
  return { root, workspace, bytes, file, reads, items, cfg, holdDownloads() { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; }, setBody(value: Buffer, type = file.mime) { body = Buffer.from(value); mime = type; } };
}

const signal = () => AbortSignal.timeout(10_000);

test('downloads exact bytes with the environment credential and preserves edits and deletions across installer restarts', async () => {
  const f = await fixture();
  const result = await installSessionAttachment(f.cfg, f.file, signal());
  expect(await fs.readFile(result.path)).toEqual(f.bytes);
  expect(f.reads).toEqual(['Bearer environment-token']);
  await fs.writeFile(result.path, 'edited');
  expect(await installSessionAttachment({ ...f.cfg }, f.file, signal())).toEqual(result);
  expect(await fs.readFile(result.path, 'utf8')).toBe('edited');
  await fs.rm(result.path);
  expect(await installSessionAttachment({ ...f.cfg }, f.file, signal())).toEqual(result);
  expect(await fs.stat(result.path).catch(() => null)).toBeNull();
  expect(f.reads).toHaveLength(1);
  await fs.rm(f.cfg.agentStateDir!, { recursive: true });
  await installSessionAttachment(f.cfg, f.file, signal());
  expect(await fs.readFile(result.path)).toEqual(f.bytes);
  expect(f.reads).toHaveLength(2);
});

test('same names with distinct contents and names that sanitize alike have distinct paths', async () => {
  const f = await fixture();
  const names = ['../report.csv', '..\\report.csv', '文'.repeat(240) + '.csv'];
  const paths: string[] = [];
  for (const filename of names) {
    const result = await installSessionAttachment(f.cfg, { ...f.file, filename }, signal());
    expect(await fs.readFile(result.path)).toEqual(f.bytes);
    expect(Buffer.byteLength(path.basename(result.path))).toBeLessThanOrEqual(215);
    paths.push(result.path);
  }
  expect(new Set(paths).size).toBe(3);
  expect(sessionAttachmentPath({ ...f.file, sha256: 'a'.repeat(64) })).not.toBe(sessionAttachmentPath(f.file));
});

test('rejects corrupt bytes, MIME mismatch, oversized downloads, pre-aborted calls, and symlink parents', async () => {
  const f = await fixture();
  f.setBody(Buffer.from('corrupt'));
  await expect(installSessionAttachment(f.cfg, f.file, signal())).rejects.toThrow('integrity');
  f.setBody(f.bytes, 'text/html');
  await expect(installSessionAttachment(f.cfg, f.file, signal())).rejects.toThrow('rejected');
  f.setBody(Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(installSessionAttachment(f.cfg, f.file, signal())).rejects.toThrow('8 MiB');
  const count = f.reads.length;
  await expect(installSessionAttachment(f.cfg, f.file, AbortSignal.abort())).rejects.toThrow();
  expect(f.reads).toHaveLength(count);
  f.setBody(f.bytes);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.workspace, 'uploads'));
  await expect(installSessionAttachment(f.cfg, f.file, signal())).rejects.toThrow('directory');
  expect(await fs.readdir(outside)).toEqual([]);
});

test('refuses to overwrite a conflicting destination and can recover a completed install without a receipt', async () => {
  const f = await fixture();
  const target = path.join(f.workspace, sessionAttachmentPath(f.file));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, 'do not overwrite');
  await expect(installSessionAttachment(f.cfg, f.file, signal())).rejects.toThrow('different bytes');
  expect(await fs.readFile(target, 'utf8')).toBe('do not overwrite');
  await fs.writeFile(target, f.bytes);
  await installSessionAttachment(f.cfg, f.file, signal());
  expect(await fs.readdir(f.cfg.agentStateDir! + '/attachments')).toHaveLength(1);
});

async function workerFixture(f: Awaited<ReturnType<typeof fixture>>, script: unknown[] = [{ text: 'Saved.' }]) {
  const rpc = createEnvRpcRouter(f.cfg);
  let calls = 0;
  const daemon = Bun.serve({ port: 0, fetch(request) { calls++; return rpc.fetch(request); } });
  cleanup.push(() => daemon.stop(true));
  const config = {
    port: 0, envUrl: daemon.url.toString().replace(/\/$/, ''), envUrlExplicit: true, envCwd: f.workspace,
    envHeaders: { 'x-kortix-user-context': mintUserContext('rpc-secret', 'environment') },
    envTransport: 'fetch' as const, systemPrompt: 'Follow the request.', modelMode: 'faux' as const,
    fauxScript: script, sessionId: 'session', kortixToken: 'worker-token', storeUrl: f.cfg.apiUrl + '/projects/project',
    storeHeaders: { authorization: 'Bearer worker-token' },
  };
  let worker = await startWorker(config);
  cleanup.push(() => worker.close());
  const request = (route: string, body?: unknown) => fetch(`http://127.0.0.1:${worker.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const id = (await (await request('/session')).json())[0].id;
  return { id, request, get calls() { return calls; }, get worker() { return worker; }, async restart(script: unknown[]) {
    await worker.close(); worker = await startWorker({ ...config, fauxScript: script });
  } };
}

test.each(['read', 'bash', 'custom'])('real worker %s keeps uploads off compute, downloads once, and replays history without bytes', async mode => {
  const f = await fixture();
  const globals = globalThis as any;
  const previous = globals.__KORTIX_PI_AGENT__;
  if (mode === 'custom') {
    globals.__KORTIX_PI_AGENT__ = (ctx: any) => ({ tools: [{ name: 'custom_read', label: 'Read attachment', description: 'Read the uploaded file', parameters: { type: 'object', properties: {} }, execute: async () => {
      const result = await ctx.env.readTextFile(sessionAttachmentPath(f.file));
      if (!result.ok) throw result.error;
      return { content: [{ type: 'text', text: result.value }] };
    } }] });
    cleanup.push(() => { globals.__KORTIX_PI_AGENT__ = previous; });
  }
  const runtime = await workerFixture(f);
  const { id, request } = runtime;
  runtime.worker.agent.state.model = { ...runtime.worker.agent.state.model!, input: ['text'] };
  const uploaded = await request(`/session/${id}/message`, { parts: [{ type: 'text', text: 'Keep this file.' }, { type: 'file', mime: f.file.mime, filename: f.file.filename, url: `kortix-attachment:sha256:${f.file.sha256}` }] });
  expect(uploaded.status).toBe(200);
  expect(runtime.calls).toBe(0);
  expect(await fs.readdir(f.workspace)).toEqual([]);
  const originalHistory = await (await request(`/session/${id}/message`)).json();
  const converted = await runtime.worker.agent.convertToLlm(runtime.worker.agent.state.messages);
  expect(JSON.stringify(converted)).toContain('uploads/.kortix-attachments/');
  expect(JSON.stringify(converted)).not.toContain('kortixAttachment');
  expect(JSON.stringify(f.items)).not.toContain(f.bytes.toString('base64'));
  await runtime.restart([{ tool: mode === 'custom' ? 'custom_read' : mode, args: mode === 'bash' ? { command: `cat '${sessionAttachmentPath(f.file)}'` } : { path: sessionAttachmentPath(f.file) } }, { text: 'Read 42.' }]);
  expect(await (await request(`/session/${id}/message`)).json()).toEqual(originalHistory);
  const read = await request(`/session/${id}/message`, { parts: [{ type: 'text', text: 'Read the uploaded CSV.' }] });
  expect(read.status).toBe(200);
  expect(await fs.readFile(path.join(f.workspace, sessionAttachmentPath(f.file)))).toEqual(f.bytes);
  const history = await (await request(`/session/${id}/message`)).json();
  expect(JSON.stringify(history)).toContain('Kortix,42');
  expect(f.reads.filter(value => value === 'Bearer environment-token')).toHaveLength(1);
}, 30_000);

test('a queued attachment is invisible to the running turn and installs only when its own turn executes', async () => {
  const f = await fixture();
  const runtime = await workerFixture(f, [
    { tool: 'bash', args: { command: 'touch ready; while [ ! -f release ]; do sleep 0.02; done' } },
    { tool: 'bash', args: { command: 'test ! -d uploads && printf QUEUED_FILE_HIDDEN' } },
    { text: 'First turn done.' },
    { tool: 'read', args: { path: sessionAttachmentPath(f.file) } },
    { text: 'Second turn read 42.' },
  ]);
  const first = runtime.request(`/session/${runtime.id}/message`, { parts: [{ type: 'text', text: 'Wait for the marker.' }] });
  try {
    const deadline = Date.now() + 3000;
    while (!await fs.stat(path.join(f.workspace, 'ready')).catch(() => null) && Date.now() < deadline) await Bun.sleep(5);
    expect(await fs.stat(path.join(f.workspace, 'ready')).then(() => true)).toBe(true);
    const queued = await runtime.request(`/session/${runtime.id}/prompt_async`, { parts: [{ type: 'text', text: 'Read the CSV next.' }, { type: 'file', mime: f.file.mime, filename: f.file.filename, url: `kortix-attachment:sha256:${f.file.sha256}` }] });
    expect(queued.status).toBe(204);
    expect(f.reads).toEqual(['Bearer worker-token']);
    await fs.writeFile(path.join(f.workspace, 'release'), 'go');
    expect((await first).status).toBe(200);
    let history = '';
    const completed = Date.now() + 3000;
    while (!history.includes('Second turn read 42.') && Date.now() < completed) {
      history = await (await runtime.request(`/session/${runtime.id}/message`)).text();
      await Bun.sleep(5);
    }
    expect(history).toContain('QUEUED_FILE_HIDDEN');
    expect(history).toContain('Second turn read 42.');
    expect(history).toContain('Kortix,42');
    expect(f.reads.filter(value => value === 'Bearer environment-token')).toHaveLength(1);
  } finally {
    await fs.writeFile(path.join(f.workspace, 'release'), 'go');
    await first;
  }
}, 15_000);


test('cancelling an in-flight attachment download writes no workspace file or receipt', async () => {
  const f = await fixture();
  const release = f.holdDownloads();
  const controller = new AbortController();
  const pending = installSessionAttachment(f.cfg, f.file, controller.signal);
  try {
    const deadline = Date.now() + 1000;
    while (!f.reads.length && Date.now() < deadline) await Bun.sleep(5);
    expect(f.reads).toHaveLength(1);
    controller.abort(new Error('Stopped download'));
    await expect(pending).rejects.toThrow('Stopped download');
    expect(await fs.readdir(f.workspace)).toEqual([]);
    expect(await fs.stat(f.cfg.agentStateDir!).catch(() => null)).toBeNull();
  } finally { release(); await pending.catch(() => {}); }
});
