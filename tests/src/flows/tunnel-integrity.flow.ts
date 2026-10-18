import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TunnelAgent, CapabilityRegistry, createFilesystemCapability, type TunnelConfig } from '../../../packages/agent-tunnel/src/agent';
import { flow } from '../core/flow';
import { pair } from '../fixtures/tunnel';

flow('TUN-6', {
  domain: 'tunnel', serial: true, timeoutMs: 120_000,
  // A deployed edge answers 403 to a WebSocket upgrade with no User-Agent.
  // Under Bun the agent names itself through `openRelaySocket` (#9576).
  routes: [
    'POST /v1/tunnel/device-auth', 'GET /v1/tunnel/device-auth/:code/status',
    'POST /v1/tunnel/device-auth/:code/approve', 'GET /v1/tunnel/connections/:tunnelId',
    'DELETE /v1/tunnel/connections/:tunnelId', 'POST /v1/tunnel/rpc/:tunnelId',
    'POST /v1/connectors/projects/:projectId/call',
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
  const project = await ctx.fixtures.project();
  try {
    await ctx.step('pair a filesystem-only machine into a project and connect a real agent over WebSocket', async () => {
      const paired = await pair(ctx.client.as(ctx.P.ANON), client, {
        name: ctx.fixtures.name('integrity'), projectId: project.id, capabilities: ['filesystem'],
      });
      tunnelId = paired.tunnelId;
      ctx.track('tunnelConnection', tunnelId);
      const config: TunnelConfig = {
        token: paired.token, tunnelId, apiUrl: `${ctx.env.apiUrl.replace(/\/$/, '')}/tunnel`, wsPath: '/ws',
        maxFileSize: 4 * 1024 * 1024, allowedPaths: [root], blockedPaths: [],
        allowedCommands: [], blockedCommands: [], workingDir: root,
        shellTimeout: 1000, shellMaxTimeout: 1000, shellMaxOutputSize: 1024, shellEnvPassthrough: [],
      };
      const registry = new CapabilityRegistry();
      registry.register(createFilesystemCapability(config));
      // `home`: the agent reads its owner's access.json there. Without it the
      // flow read the developer's real ~/.agent-tunnel (an expired "ask" grant
      // failed it with computer_access_pending and woke their desktop app).
      agent = new TunnelAgent(config, registry, {}, { home: root });
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
    await ctx.step('empty tool arguments return 400 and write nothing', async () => {
      (await rpc({})).status(400);
      assert.equal(await Bun.file(path).exists(), false);
    });
    await ctx.step('a capability not approved at pairing returns 403 computer_capability_not_approved', async () => {
      const r = await client.post('/v1/tunnel/rpc/:tunnelId', { method: 'shell.exec', params: { command: 'true' } }, { params: { tunnelId } });
      r.status(403).body().has('$.error', 'computer_capability_not_approved');
    });
    await ctx.step('the pairing grant covers the write: the real fs_upload CLI delivers the XLSX', async () => {
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
    await ctx.step("the project's computer account preserves the XLSX payload and returns its persisted digest", async () => {
      const result = await client.post('/v1/connectors/projects/:projectId/call', {
        connector: 'computer', action: 'fs.write', args: { path, content: bytes.toString('base64'), encoding: 'base64', sha256 },
      }, { params: { projectId: project.id } });
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
