import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config';
import { buildOpencodeApp } from '../proxy';
import { createPtyRegistry } from '../routes/pty';
import { workspaceAccess } from '../workspace-access';
import { WorkspaceHistory } from '../workspace-history';
import { mintUserContext } from '../../../kortix-worker/src/lazy-env';
import type { Opencode } from '../opencode';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'history-access-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const cfg = loadConfig({ KORTIX_WORKSPACE: workspace, KORTIX_TOKEN: 'fixture-secret', KORTIX_ENV_RPC_SECRET: 'fixture-secret', KORTIX_PROJECT_ID: 'p', KORTIX_SESSION_ID: 's', KORTIX_WORKLOAD: 'environment', KORTIX_ENVIRONMENT_HISTORY: '1', KORTIX_AGENT_STATE_DIR: path.join(root, 'state') });
  const opencode = { getState: () => 'disabled', getPid: () => null } as unknown as Opencode;
  const registry = createPtyRegistry(cfg);
  const app = buildOpencodeApp(cfg, opencode, Date.now(), undefined, undefined, null, registry);
  const request = (url: string, body: unknown) => app.request(url, { method: 'POST', headers: { 'x-kortix-user-context': mintUserContext('fixture-secret', 'env'), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const history = new WorkspaceHistory({ workspace, state: path.join(root, 'state', 'workspace-history'), scope: JSON.stringify(['p', 's']) });
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace, cfg, request, history, registry };
}
test('workspace history excludes Files, VCS and new terminal writers, and releases the gate after failure', async () => {
  const { cfg, request, registry } = await fixture();
  const release = workspaceAccess(cfg)!.enter(true)!;
  try {
    for (const route of ['/file/mkdir', '/file/upload', '/vcs/apply', '/kortix/git/commit', '/kortix/pty']) {
      expect((await request(route, { path: 'new' })).status).toBe(409);
    }
    expect(() => registry.create({})).toThrow('Workspace history is busy');
  } finally { release(); }
  expect((await request('/file/mkdir', { path: 'new' })).status).toBe(200);
});
test('a persisted incomplete rollback excludes file writes after daemon reconstruction', async () => {
  const { root, workspace, cfg, history, request } = await fixture();
  const before = await history.capture(crypto.randomUUID());
  await fs.writeFile(path.join(workspace, 'a'), 'after');
  const after = await history.capture(crypto.randomUUID());
  const move = { operationId: crypto.randomUUID(), from: after.snapshotId, to: before.snapshotId };
  const broken = new WorkspaceHistory({ workspace, state: path.join(root, 'state', 'workspace-history'), scope: JSON.stringify(['p', 's']), afterMutation: () => { throw new Error('crash'); } });
  await expect(broken.apply(move)).rejects.toThrow('crash');
  expect(workspaceAccess({ ...cfg })!.locked).toBe(true);
  expect((await request('/file/mkdir', { path: 'new' })).status).toBe(409);
  await history.apply(move);
  expect((await request('/file/mkdir', { path: 'new' })).status).toBe(200);
});
test('a running terminal refuses file rollback without changing files', async () => {
  const { workspace, cfg, history, request } = await fixture();
  const before = await history.capture(crypto.randomUUID());
  await fs.writeFile(path.join(workspace, 'a'), 'after');
  const after = await history.capture(crypto.randomUUID());
  workspaceAccess(cfg)!.terminalActive = () => true;
  const response = await request('/kortix/env-rpc/rpc', { op: 'historyApply', args: { operationId: crypto.randomUUID(), from: after.snapshotId, to: before.snapshotId } });
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'busy' } });
  expect(await fs.readFile(path.join(workspace, 'a'), 'utf8')).toBe('after');
});
