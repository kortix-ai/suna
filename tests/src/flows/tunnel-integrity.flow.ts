import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TunnelAgent, CapabilityRegistry, createFilesystemCapability, type TunnelConfig } from '../../../packages/agent-tunnel/src/agent';
import { flow } from '../core/flow';
import { eventually } from '../core/poll';
import { pair } from '../fixtures/tunnel';

// The quarantine below applies to DEPLOYED targets only. Locally there is no
// WAF in front of the API, the same handshake succeeds, and the local lane
// (`localRunExitCode`) treats ANY skipped flow as a failure — so the flow keeps
// running there and keeps its coverage. Read at module scope: the runner
// discovers flow modules inside `runSuite`, after the local profile has put
// `KE2E_TARGET=local` on `process.env`, and every deployed workflow sets
// `KE2E_TARGET` in its job env.
const KE2E_TARGET = process.env.KE2E_TARGET ?? process.env.E2E_TARGET ?? 'local';
const WAF_FRONTED_TARGET = KE2E_TARGET !== 'local';

flow('TUN-6', {
  domain: 'tunnel', serial: true, timeoutMs: 120_000,
  // QUARANTINED 2026-09-15 — deterministic on every WAF-fronted target
  // (staging, prod). The in-process TunnelAgent opens its WebSocket with the
  // runtime's global `WebSocket`; under Bun (the ke2e runner) that handshake
  // carries NO User-Agent, and AWS WAF's managed rule set answers 403 before the
  // API sees it (curl proof: no UA → 403 text/html via Cloudflare; any UA → 401
  // JSON from /v1/tunnel/ws). Node's global WebSocket sends `User-Agent: node`,
  // so the published `@kortix/agent-tunnel` bin that users run is unaffected.
  // Failed 5/5 handshakes in release gate run 34989061001 (v0.13.16, api shard 1,
  // job 104486189580: "agent must become live" after five "WebSocket error").
  // The flow was added by #7241 without a green deployed run, which the
  // learnings register forbids. Un-quarantine ONLY in the PR that makes
  // TunnelAgent send an identifying User-Agent under Bun (or gives the flow a
  // UA-bearing WebSocket) AND links a green `tests-release.yml` dry run
  // against staging.
  ...(WAF_FRONTED_TARGET
    ? {
        quarantine:
          'TunnelAgent WebSocket handshake from Bun carries no User-Agent; AWS WAF on staging/prod answers 403 (run 34989061001 attempt 4, job 104486189580)',
      }
    : {}),
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
      await eventually(async () => {
        const r = await client.get('/v1/tunnel/connections/:tunnelId', { params: { tunnelId } });
        r.status(200);
        return r.json<any>().isLive;
      }, {
        until: (live) => live,
        timeoutMs: 15_000,
        intervalMs: 100,
        timeoutError: () => new Error('agent must become live'),
      });
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
