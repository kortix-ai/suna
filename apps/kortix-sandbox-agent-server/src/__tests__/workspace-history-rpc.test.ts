import { afterEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config';
import { createEnvRpcRouter } from '../routes/env-rpc';
import { WorkspaceHistory } from '../workspace-history';

const secret = 'test-history-environment-secret';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const done of cleanup.splice(0)) await done(); });
function auth(key = secret) {
  const payload = Buffer.from(JSON.stringify({ userId: 'worker', sandboxId: 'environment', sandboxRole: 'owner', scopes: [], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  return payload + '.' + createHmac('sha256', key).update(payload).digest('base64url');
}
async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-rpc-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const cfg = loadConfig({ KORTIX_WORKSPACE: workspace, KORTIX_ENV_RPC_SECRET: secret, KORTIX_PROJECT_ID: 'project', KORTIX_SESSION_ID: 'session', KORTIX_WORKLOAD: 'environment', KORTIX_ENVIRONMENT_HISTORY: '1', KORTIX_AGENT_STATE_DIR: path.join(root, 'state'), ...overrides });
  const app = createEnvRpcRouter(cfg);
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const request = (body: unknown, key = secret) => fetch(`http://127.0.0.1:${server.port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kortix-user-context': auth(key) }, body: JSON.stringify(body) });
  const call = async (op: string, args: Record<string, unknown> = {}, cwd?: string) => {
    const response = await request({ op, args, cwd });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  const history = new WorkspaceHistory({ workspace, state: path.join(root, 'state', 'workspace-history'), scope: JSON.stringify(['project', 'session']) });
  cleanup.push(async () => { server.stop(true); await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace, cfg, request, call, history };
}

test('authenticated HTTP captures and restores only the configured workspace with idempotent receipts', async () => {
  const { root, workspace, call } = await fixture();
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'outside');
  await fs.writeFile(path.join(workspace, 'a'), 'before');
  const before = await call('historyCapture', { captureId: crypto.randomUUID(), workspace: outside, scope: 'foreign' }, outside);
  expect(before).toMatchObject({ ok: true, value: { files: 1, bytes: 6 } });
  await call('writeFile', { path: 'a', content: 'after' });
  const after = await call('historyCapture', { captureId: crypto.randomUUID() });
  const move = { operationId: crypto.randomUUID(), from: after.value.snapshotId, to: before.value.snapshotId };
  expect(await call('historyApply', move)).toMatchObject({ ok: true, value: { status: 'complete', changedPaths: ['a'] } });
  expect(await fs.readFile(path.join(workspace, 'a'), 'utf8')).toBe('before');
  expect(await fs.readFile(path.join(outside, 'secret'), 'utf8')).toBe('outside');
  await call('writeFile', { path: 'a', content: 'later' });
  expect(await call('historyApply', move)).toMatchObject({ ok: true, value: { status: 'complete' } });
  expect(await fs.readFile(path.join(workspace, 'a'), 'utf8')).toBe('later');
  expect(await call('historyPending')).toEqual({ ok: true, value: null });
});

test.each([
  { KORTIX_ENVIRONMENT_HISTORY: undefined },
  { KORTIX_ENVIRONMENT_HISTORY: '0' },
  { KORTIX_WORKLOAD: '' },
  { KORTIX_PROJECT_ID: undefined },
  { KORTIX_SESSION_ID: undefined },
])('history is unavailable without explicit environment configuration %j', async overrides => {
  const { root, call } = await fixture(overrides);
  expect(await call('historyCapture', { captureId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'not_supported' } });
  expect(await call('writeFile', { path: 'a', content: 'ordinary' })).toMatchObject({ ok: true });
  expect(await fs.stat(path.join(root, 'state')).catch(() => null)).toBeNull();
});

test('HTTP rejects foreign authentication and malformed checkpoint identities without writes', async () => {
  const { root, request, call } = await fixture();
  expect((await request({ op: 'historyCapture', args: { captureId: crypto.randomUUID() } }, 'wrong')).status).toBe(401);
  expect(await fs.stat(path.join(root, 'state')).catch(() => null)).toBeNull();
  expect(await call('historyCapture', { captureId: '../escape' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
  expect(await call('historyApply', { operationId: crypto.randomUUID(), from: null, to: 'missing' })).toMatchObject({ ok: false, error: { code: 'invalid' } });
});

test('a pending file move gates ordinary RPC writes until the same receipt completes', async () => {
  const { root, workspace, history, call } = await fixture();
  for (const name of ['a', 'b']) await fs.writeFile(path.join(workspace, name), 'before');
  const before = await history.capture(crypto.randomUUID());
  for (const name of ['a', 'b']) await fs.writeFile(path.join(workspace, name), 'after');
  const after = await history.capture(crypto.randomUUID());
  const move = { operationId: crypto.randomUUID(), from: after.snapshotId, to: before.snapshotId };
  const failing = new WorkspaceHistory({ workspace, state: path.join(root, 'state', 'workspace-history'), scope: JSON.stringify(['project', 'session']), afterMutation: () => { throw new Error('crash'); } });
  await expect(failing.apply(move)).rejects.toThrow('crash');
  expect(await call('historyPending')).toMatchObject({ ok: true, value: { status: 'applying' } });
  expect(await call('writeFile', { path: 'b', content: 'unexpected' })).toMatchObject({ ok: false, error: { code: 'pending' } });
  expect(await fs.readFile(path.join(workspace, 'b'), 'utf8')).toBe('after');
  expect(await call('historyApply', move)).toMatchObject({ ok: true, value: { status: 'complete' } });
  expect(await call('writeFile', { path: 'b', content: 'later' })).toMatchObject({ ok: true });
});

test('a live streaming shell prevents a checkpoint until execution finishes', async () => {
  const { workspace, request, call } = await fixture();
  const response = await request({ op: 'exec', stream: true, args: { command: 'printf READY; while [ ! -f release ]; do sleep 0.01; done', timeout: 5000 } });
  const reader = response.body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('READY');
    expect(await call('historyCapture', { captureId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'busy' } });
  } finally { await fs.writeFile(path.join(workspace, 'release'), ''); }
  while (!(await reader.read()).done) {}
  expect(await call('historyCapture', { captureId: crypto.randomUUID() })).toMatchObject({ ok: true });
});

test('invalid checkpoint identity refuses rewind without disabling ordinary environment tools', async () => {
  const { workspace, call } = await fixture();
  expect(await call('historyCapture', { captureId: crypto.randomUUID() })).toMatchObject({ ok: true });
  await fs.rm(path.join(workspace, '.kortix-workspace-id'));
  expect(await call('historyCapture', { captureId: crypto.randomUUID() })).toMatchObject({ ok: false, error: { code: 'identity' } });
  expect(await call('writeFile', { path: 'a', content: 'preserved', __kortixHistoryOperation: crypto.randomUUID() })).toMatchObject({ ok: true, workspace: null });
  expect(await call('readTextFile', { path: 'a' })).toMatchObject({ ok: true, value: 'preserved' });
});
