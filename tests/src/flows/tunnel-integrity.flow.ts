import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TunnelAgent, CapabilityRegistry, createFilesystemCapability, type TunnelConfig } from '../../../packages/agent-tunnel/src/agent';
import { flow } from '../core/flow';

flow('TUN-6', {
  domain: 'tunnel', serial: true, timeoutMs: 120_000,
  routes: [
    'POST /v1/tunnel/connections', 'GET /v1/tunnel/connections/:tunnelId',
    'DELETE /v1/tunnel/connections/:tunnelId', 'POST /v1/tunnel/rpc/:tunnelId',
    'GET /v1/tunnel/permission-requests', 'POST /v1/tunnel/permission-requests/:requestId/approve',
    'POST /v1/tunnel/permission-requests/:requestId/deny',
    'POST /v1/tunnel/permissions/:tunnelId',
    'POST /v1/connectors/projects/:projectId/connectors', 'POST /v1/connectors/projects/:projectId/call',
  ],
}, async ctx => {
  const root = await mkdtemp(join(tmpdir(), 'ke2e-tunnel-integrity-'));
  const path = join(root, 'delivered.xlsx');
  const source = resolve(import.meta.dir, '../../fixtures/tunnel-integrity.xlsx');
  const bytes = await readFile(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const client = ctx.client.as(ctx.P.OWNER);
  let tunnelId = '';
  let agent: TunnelAgent | undefined;
  const rpc = (params: Record<string, unknown>) => client.post('/v1/tunnel/rpc/:tunnelId', { method: 'fs.write', params }, { params: { tunnelId } });
  try {
    await ctx.step('register a filesystem tunnel and connect a real agent over WebSocket', async () => {
      const response = await client.post('/v1/tunnel/connections', { name: ctx.fixtures.name('integrity'), capabilities: ['filesystem'] });
      response.status(201);
      const registration = response.json<any>();
      tunnelId = registration.tunnelId;
      ctx.track('tunnelConnection', tunnelId);
      const config: TunnelConfig = {
        token: registration.setupToken, tunnelId, apiUrl: `${ctx.env.apiUrl.replace(/\/$/, '')}/tunnel`, wsPath: '/ws',
        maxFileSize: 4 * 1024 * 1024, allowedPaths: [root], blockedPaths: [],
        allowedCommands: [], blockedCommands: [], workingDir: root,
        shellTimeout: 1000, shellMaxTimeout: 1000, shellMaxOutputSize: 1024, shellEnvPassthrough: [],
      };
      const registry = new CapabilityRegistry();
      registry.register(createFilesystemCapability(config));
      agent = new TunnelAgent(config, registry);
      agent.connect();
      const deadline = Date.now() + 15000;
      while (true) {
        const r = await client.get('/v1/tunnel/connections/:tunnelId', { params: { tunnelId } });
        r.status(200);
        if (r.json<any>().isLive) break;
        assert.ok(Date.now() < deadline, 'agent must become live');
        await Bun.sleep(100);
      }
    });
    await ctx.step('empty tool arguments return 400 and create no permission request', async () => {
      (await rpc({})).status(400);
      const pending = await client.get('/v1/tunnel/permission-requests');
      pending.status(200);
      assert.equal(pending.json<any[]>().filter(row => row.tunnelId === tunnelId).length, 0);
      assert.equal(await Bun.file(path).exists(), false);
    });
    await ctx.step('valid unapproved write returns 403; denial leaves the destination absent', async () => {
      const r = await rpc({ path, content: bytes.toString('base64'), encoding: 'base64', sha256 });
      r.status(403);
      const requestId = r.json<any>().requestId;
      assert.ok(requestId);
      (await client.post('/v1/tunnel/permission-requests/:requestId/deny', {}, { params: { requestId } })).status(200);
      (await client.post('/v1/tunnel/permission-requests/:requestId/approve', {}, { params: { requestId } })).status(409);
      assert.equal(await Bun.file(path).exists(), false);
    });
    await ctx.step('concurrent approve and deny produce one winner and one 409', async () => {
      const r = await rpc({ path, content: 'pending' }); r.status(403);
      const requestId = r.json<any>().requestId;
      const outcomes = await Promise.all(['approve', 'deny'].map(action => client.post(`/v1/tunnel/permission-requests/:requestId/${action}`, {}, { params: { requestId } })));
      // Both responses must be terminal, but only one decision may succeed.
      const statuses = outcomes.map(r => { r.status([200, 409]); return r.statusCode; }).sort();
      assert.deepEqual(statuses, [200, 409]);
      assert.equal(await Bun.file(path).exists(), false);
    });
    await ctx.step('grant scoped filesystem write permission and run the real fs_upload CLI', async () => {
      const r = await client.post('/v1/tunnel/permissions/:tunnelId', { capability: 'filesystem', scope: { paths: [path], operations: ['write'] } }, { params: { tunnelId } }); r.status(201);
      assert.equal(ctx.P.OWNER.auth.mode, 'bearer');
      if (ctx.P.OWNER.auth.mode !== 'bearer') throw new Error('OWNER bearer required');
      const proc = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../../packages/agent-tunnel/src/client/cli.ts'), 'fs_upload', JSON.stringify({ source, path })], {
        env: { ...process.env, S6_ENV_DIR: join(root, 'no-s6'), TUNNEL_API_URL: ctx.env.apiUrl.replace(/\/v1\/?$/, ''), TUNNEL_TOKEN: ctx.P.OWNER.auth.token, TUNNEL_ID: tunnelId },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      assert.equal(exit, 0, stderr + stdout);
      assert.equal(stderr, '');
      assert.deepEqual(JSON.parse(stdout), { success: true, path, size: bytes.length, sha256 });
      assert.deepEqual(await readFile(path), bytes);
    });
    await ctx.step('Computer Tunnel connector preserves the XLSX payload and returns its persisted digest', async () => {
      const project = await ctx.fixtures.project();
      const projectParams = { params: { projectId: project.id } };
      const created = await client.post('/v1/connectors/projects/:projectId/connectors', {
        slug: 'integrity-computer', name: 'Integrity computer', provider: 'computer', tunnel_ids: [tunnelId], create_only: true,
      }, projectParams);
      created.status(200);
      const result = await client.post('/v1/connectors/projects/:projectId/call', {
        connector: 'integrity-computer', action: 'fs.write', args: { path, content: bytes.toString('base64'), encoding: 'base64', sha256 },
      }, projectParams);
      result.status(200).body().has('$.ok', true).has('$.data.sha256', sha256).has('$.data.size', bytes.length);
      assert.deepEqual(await readFile(path), bytes);
    });
    await ctx.step('same-length corruption and malformed base64 fail without replacing the verified XLSX', async () => {
      const corrupt = Buffer.from(bytes); corrupt[100] ^= 1;
      const mismatch = await rpc({ path, content: corrupt.toString('base64'), encoding: 'base64', sha256 });
      mismatch.status(500);
      assert.match(mismatch.json<any>().error, /SHA-256 mismatch/);
      (await rpc({ path, content: 'aGVsbG8=!', encoding: 'base64' })).status(400);
      assert.deepEqual(await readFile(path), bytes);
    });
  } finally {
    agent?.disconnect();
    if (tunnelId) (await client.del('/v1/tunnel/connections/:tunnelId', { params: { tunnelId } })).status(200);
    await rm(root, { recursive: true, force: true });
  }
});
