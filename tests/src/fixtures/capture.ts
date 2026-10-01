/**
 * Kortix Capture fixtures for CAP-2: record one synthetic frame for a member,
 * and mint the session credential an agent sandbox holds.
 *
 * `mintSessionCredential` reproduces the token row `mintSessionToken` writes
 * (apps/api/src/platform/services/session-sandbox.ts): an API-minted PAT bound
 * to account, project and session, `user_id` = the launcher, and
 * `on_behalf_of_user_id` = the launching human, or NULL for a trigger run. The
 * local profile has no sandbox provider, so no route reaches the real mint
 * (same limit as fixtures/agent-principals.ts). The mint itself is not
 * exercised here. Every byte and frame is synthetic.
 */
import { randomUUID } from 'node:crypto';
import type { Client } from '../core/client';
import type { FlowContext, Principal } from '../core/types';
import { startPairing } from './tunnel';
import { openDb, type Db } from './agent-principals';

/** Pair a machine as `who`, move it to `accountId`, turn it on, upload one chunk with one frame. */
export async function recordFrame(
  ctx: FlowContext,
  input: { accountId: string; who: Principal; text: string; title: string; ts: string },
): Promise<{ frameId: number; chunkId: string; deviceId: string }> {
  const anon = ctx.client.as(ctx.P.ANON);
  const me = ctx.client.as(input.who);
  const pairing = await startPairing(anon, { machineHostname: `${ctx.fixtures.name('cap2')}.local` });
  pairing.status(201);
  const { deviceCode, deviceSecret } = pairing.json<any>();
  const approved = await me.post(
    '/v1/tunnel/device-auth/:code/approve',
    { name: ctx.fixtures.name('cap2-laptop'), capabilities: [] },
    { params: { code: deviceCode } },
  );
  approved.status(200);
  const tunnelId = approved.json<any>().tunnelId as string;
  ctx.track('tunnelConnection', tunnelId);
  const token = (
    await anon.withBearer(deviceSecret).get('/v1/tunnel/device-auth/:code/status', { params: { code: deviceCode } })
  ).json<any>().token;
  const machine = anon.withBearer(token);
  const h = { headers: { 'x-tunnel-id': tunnelId } };
  await machine.get('/v1/capture/agent/config', h);
  const device = (await me.get('/v1/capture/devices')).json<any>().devices.find((d: any) => d.tunnel_id === tunnelId);
  (await me.put('/v1/capture/devices/:deviceId', { account_id: input.accountId, enabled: true }, { params: { deviceId: device.id } })).status(200);

  const video = new Uint8Array(256).map((_, i) => (i * 5) % 251);
  const started = new Date(input.ts);
  const reg = (
    await machine.post(
      '/v1/capture/agent/chunks',
      {
        client_uid: randomUUID(),
        started_at: started.toISOString(),
        ended_at: new Date(started.getTime() + 60_000).toISOString(),
        frame_count: 1,
        width: 640,
        height: 480,
        codec: 'h264',
        video_bytes: video.byteLength,
        video_sha256: new Bun.CryptoHasher('sha256').update(video).digest('hex'),
      },
      h,
    )
  )
    .status(200)
    .json<any>();
  const put = await fetch(reg.upload.url, { method: reg.upload.method, headers: reg.upload.headers, body: video });
  if (put.status !== 200) throw new Error(`capture upload: ${put.status} ${await put.text()}`);
  (
    await machine.post(
      '/v1/capture/agent/chunks/:chunkId/commit',
      { frames: [{ frame_index: 0, ts: input.ts, app_name: 'Notes', window_title: input.title, text: input.text }] },
      { params: { chunkId: reg.chunk_id }, ...h },
    )
  ).status(200);
  const found = (
    await me.get('/v1/accounts/:accountId/capture/search', { params: { accountId: input.accountId }, query: { q: input.title } })
  ).json<any>();
  return { frameId: found.items[0].frame_id, chunkId: reg.chunk_id, deviceId: device.id };
}

export interface SessionCredential {
  sessionId: string;
  secret: string;
  client: Client;
}

export class SessionCredentials {
  private constructor(
    private readonly ctx: FlowContext,
    private readonly db: Db,
    private readonly accountId: string,
    private readonly projectId: string,
  ) {}

  static async open(ctx: FlowContext, accountId: string, projectId: string) {
    return new SessionCredentials(ctx, await openDb(ctx), accountId, projectId);
  }

  /** `human` = the person the session acts for; `null` = a trigger run (the account owner stands in as `user_id`). */
  async mint(input: { human: Principal | null; visibility?: 'private' | 'project' }): Promise<SessionCredential> {
    const sessionId = randomUUID();
    const holder = input.human ?? this.ctx.P.OWNER;
    const minted = await this.ctx.client.as(holder).post('/v1/accounts/tokens', { name: `CAP-2 ${sessionId.slice(0, 8)}` });
    minted.status(201);
    const { token_id: tokenId, secret_key: secret } = minted.json<{ token_id: string; secret_key: string }>();
    await this.db.query(
      `INSERT INTO kortix.project_sessions (session_id, account_id, project_id, branch_name, agent_name, status, created_by, visibility, metadata)
       VALUES ($1, $2, $3, $1, 'kortix', 'running', $4, $5::kortix.project_session_visibility, $6::jsonb)`,
      [sessionId, this.accountId, this.projectId, holder.userId, input.visibility ?? 'private',
        JSON.stringify({ workspace_mode: 'branch', ...(input.human ? {} : { trigger_kind: 'cron', trigger_source: 'manual', trigger_slug: 'cap-2' }) })],
    );
    await this.db.query(
      `INSERT INTO kortix.session_sandboxes (sandbox_id, session_id, account_id, project_id, status) VALUES ($1::uuid, $1, $2, $3, 'active')`,
      [sessionId, this.accountId, this.projectId],
    );
    await this.db.query(
      `UPDATE kortix.account_tokens SET account_id = $2, user_id = $3, project_id = $4, session_id = $5, on_behalf_of_user_id = $6 WHERE token_id = $1`,
      [tokenId, this.accountId, holder.userId, this.projectId, sessionId, input.human?.userId ?? null],
    );
    return { sessionId, secret, client: this.ctx.client.withBearer(secret, `SESSION_${sessionId.slice(0, 8)}`) };
  }

  async close() {
    await this.db.end();
  }
}
