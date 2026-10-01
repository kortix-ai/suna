/**
 * Kortix Capture user API (user JWT or PAT, `combinedAuth`).
 *
 *   GET/PUT /v1/accounts/:accountId/capture/settings
 *   GET     /v1/capture/devices            PUT /v1/capture/devices/:deviceId (enabled, paused_until, account_id)
 *   GET     /v1/accounts/:accountId/capture/{search,timeline}
 *   GET     /v1/accounts/:accountId/capture/chunks/:chunkId/video
 *   GET     /v1/accounts/:accountId/capture/frames/:frameId
 *   DELETE  /v1/accounts/:accountId/capture/data
 *
 * Recordings belong to the user who captured them. An account owner or admin
 * reads another member's recordings only while the owner has switched on
 * `admins_can_view`; every such read writes the audit event `capture.member_view`.
 */
import { captureAccountSettings, captureChunks, captureDevices, captureFrames, tunnelConnections } from '@kortix/db';
import { and, desc, eq, gte, lt, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { accountSessionGate } from '../iam/session-gate';
import { accountRoleFor, isAccountManagerRole, type AccountRoleKey } from '../iam/read-models';
import { combinedAuth } from '../middleware/auth';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import { readJsonObject } from '../shared/http-body';
import { isUuid } from '../shared/validate';
import type { AppEnv } from '../types';
import { deleteChunks } from './chunks';
import { VIDEO_URL_TTL_SECONDS, captureStore } from './store';

const DEFAULT_RETENTION_DAYS = 30;

type Ctx = { userId: string; accountId: string; role: AccountRoleKey };

const err = (c: any, status: 400 | 403 | 404 | 503, code: string, error: string) => c.json({ error, code }, status);

const settingsRow = async (accountId: string) =>
  (await db.select().from(captureAccountSettings).where(eq(captureAccountSettings.accountId, accountId)))[0];

/** The caller as a member of `:accountId`, or the response to send. */
async function member(c: any): Promise<{ ctx: Ctx } | { response: Response }> {
  const accountId = c.req.param('accountId');
  if (!isUuid(accountId)) return { response: err(c, 400, 'CAPTURE_BAD_REQUEST', 'accountId must be a UUID') };
  const userId = c.get('userId') as string;
  const role = await accountRoleFor(accountId, userId);
  if (!role) return { response: err(c, 403, 'CAPTURE_NOT_A_MEMBER', 'Not a member of this account') };
  return { ctx: { userId, accountId, role } };
}

/**
 * May the caller read `ownerId`'s recordings? Own data always. Another member's
 * only for owner/admin while `admins_can_view` is on; that read is audited.
 */
async function mayRead(c: any, ctx: Ctx, ownerId: string, via: string): Promise<boolean> {
  if (ownerId === ctx.userId) return true;
  if (!isAccountManagerRole(ctx.role) || !(await settingsRow(ctx.accountId))?.adminsCanView) return false;
  await recordAuditEvent({
    accountId: ctx.accountId,
    actorUserId: ctx.userId,
    actorType: 'human',
    action: 'capture.member_view',
    resourceType: 'capture_member',
    resourceId: ownerId,
    outcome: 'success',
    metadata: { via },
  });
  return true;
}

const denied = (c: any) =>
  err(c, 403, 'CAPTURE_MEMBER_VIEW_FORBIDDEN', "Viewing a member's captures needs an owner or admin, and the owner must enable it");

function parseDate(c: any, name: string): Date | null | 'bad' {
  const raw = c.req.query(name);
  if (raw === undefined || raw === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 'bad' : d;
}

const settingsBody = (row: typeof captureAccountSettings.$inferSelect | undefined) => ({
  enabled: row?.enabled ?? false,
  admins_can_view: row?.adminsCanView ?? false,
  retention_days: row?.retentionDays ?? DEFAULT_RETENTION_DAYS,
  updated_at: row?.updatedAt.toISOString() ?? null,
});

export function createCaptureUserRouter() {
  const router = new Hono<AppEnv>();
  router.use('/capture/devices', combinedAuth);
  router.use('/capture/devices/*', combinedAuth);
  router.use('/accounts/:accountId/capture/*', combinedAuth, accountSessionGate());

  // ── Settings ──────────────────────────────────────────────────────────────
  router.get('/accounts/:accountId/capture/settings', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    return c.json(settingsBody(await settingsRow(m.ctx.accountId)));
  });

  router.put('/accounts/:accountId/capture/settings', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    const { ctx } = m;
    if (!isAccountManagerRole(ctx.role)) return err(c, 403, 'CAPTURE_FORBIDDEN', 'Only an owner or admin can change capture settings');
    const body = await readJsonObject(c);
    const before = settingsBody(await settingsRow(ctx.accountId));
    const next = { ...before };
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return err(c, 400, 'CAPTURE_BAD_REQUEST', 'enabled must be a boolean');
      next.enabled = body.enabled;
    }
    if ('admins_can_view' in body) {
      if (typeof body.admins_can_view !== 'boolean') return err(c, 400, 'CAPTURE_BAD_REQUEST', 'admins_can_view must be a boolean');
      next.admins_can_view = body.admins_can_view;
    }
    if ('retention_days' in body) {
      const days = body.retention_days;
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 3650) {
        return err(c, 400, 'CAPTURE_BAD_REQUEST', 'retention_days must be an integer from 1 to 3650');
      }
      next.retention_days = days;
    }
    if (next.admins_can_view !== before.admins_can_view && ctx.role !== 'owner') {
      return err(c, 403, 'CAPTURE_FORBIDDEN', 'Only the account owner can change admins_can_view');
    }
    const changed =
      next.enabled !== before.enabled || next.admins_can_view !== before.admins_can_view || next.retention_days !== before.retention_days;
    const values = {
      enabled: next.enabled,
      adminsCanView: next.admins_can_view,
      retentionDays: next.retention_days,
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(captureAccountSettings)
      .values({ accountId: ctx.accountId, ...values })
      .onConflictDoUpdate({ target: captureAccountSettings.accountId, set: values })
      .returning();
    if (changed) {
      await recordAuditEvent({
        accountId: ctx.accountId,
        actorUserId: ctx.userId,
        actorType: 'human',
        action: 'capture.settings.changed',
        resourceType: 'capture_settings',
        resourceId: ctx.accountId,
        outcome: 'success',
        before: { enabled: before.enabled, admins_can_view: before.admins_can_view, retention_days: before.retention_days },
        after: { enabled: next.enabled, admins_can_view: next.admins_can_view, retention_days: next.retention_days },
      });
    }
    return c.json(settingsBody(row));
  });

  // ── Devices (the caller's own machines, every account) ────────────────────
  router.get('/capture/devices', async (c) => {
    const userId = c.get('userId') as string;
    const rows = await db
      .select({
        device: captureDevices,
        name: tunnelConnections.name,
        accountEnabled: captureAccountSettings.enabled,
        adminsCanView: captureAccountSettings.adminsCanView,
      })
      .from(captureDevices)
      .innerJoin(tunnelConnections, eq(tunnelConnections.tunnelId, captureDevices.tunnelId))
      .leftJoin(captureAccountSettings, eq(captureAccountSettings.accountId, captureDevices.accountId))
      .where(eq(captureDevices.userId, userId))
      .orderBy(desc(captureDevices.createdAt));
    return c.json({
      devices: rows.map(({ device, name, accountEnabled, adminsCanView }) => ({
        id: device.id,
        account_id: device.accountId,
        tunnel_id: device.tunnelId,
        name,
        enabled: device.enabled,
        paused_until: device.pausedUntil?.toISOString() ?? null,
        last_upload_at: device.lastUploadAt?.toISOString() ?? null,
        last_seen_at: device.lastSeenAt?.toISOString() ?? null,
        account_enabled: accountEnabled ?? false,
        admins_can_view: adminsCanView ?? false,
      })),
    });
  });

  router.put('/capture/devices/:deviceId', async (c) => {
    const deviceId = c.req.param('deviceId');
    if (!isUuid(deviceId)) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'deviceId must be a UUID');
    const body = await readJsonObject(c);
    const set: Partial<typeof captureDevices.$inferInsert> = {};
    if ('enabled' in body) {
      if (typeof body.enabled !== 'boolean') return err(c, 400, 'CAPTURE_BAD_REQUEST', 'enabled must be a boolean');
      set.enabled = body.enabled;
    }
    if ('paused_until' in body) {
      if (body.paused_until === null) set.pausedUntil = null;
      else {
        const d = typeof body.paused_until === 'string' ? new Date(body.paused_until) : null;
        if (!d || Number.isNaN(d.getTime())) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'paused_until must be an ISO date or null');
        set.pausedUntil = d;
      }
    }
    if ('account_id' in body) {
      // Which account owns this device's recordings: any account the caller belongs to.
      const accountId = body.account_id;
      if (!isUuid(accountId)) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'account_id must be a UUID');
      if (!(await accountRoleFor(accountId, c.get('userId') as string))) {
        return err(c, 403, 'CAPTURE_NOT_A_MEMBER', 'Not a member of this account');
      }
      set.accountId = accountId;
    }
    if (Object.keys(set).length === 0) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'Send enabled, paused_until and/or account_id');
    const [row] = await db
      .update(captureDevices)
      .set(set)
      .where(and(eq(captureDevices.id, deviceId), eq(captureDevices.userId, c.get('userId') as string)))
      .returning();
    if (!row) return err(c, 404, 'CAPTURE_DEVICE_NOT_FOUND', 'Device not found');
    return c.json({ id: row.id, account_id: row.accountId, enabled: row.enabled, paused_until: row.pausedUntil?.toISOString() ?? null });
  });

  // ── Search ────────────────────────────────────────────────────────────────
  router.get('/accounts/:accountId/capture/search', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    const { ctx } = m;
    const target = c.req.query('user_id') || ctx.userId;
    if (!isUuid(target)) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'user_id must be a UUID');
    const from = parseDate(c, 'from');
    const to = parseDate(c, 'to');
    if (from === 'bad' || to === 'bad') return err(c, 400, 'CAPTURE_BAD_REQUEST', 'from and to must be ISO dates');
    const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '', 10) || 20, 1), 100);
    const q = (c.req.query('q') ?? '').trim().slice(0, 500);
    const cursor = decodeCursor(c.req.query('cursor'));
    if (c.req.query('cursor') && !cursor) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'Invalid cursor');
    if (!(await mayRead(c, ctx, target, 'search'))) return denied(c);

    const query = sql`websearch_to_tsquery('simple', ${q})`;
    const where: SQL[] = [eq(captureFrames.accountId, ctx.accountId), eq(captureFrames.userId, target)];
    if (q) where.push(sql`${captureFrames.tsv} @@ ${query}`);
    if (from) where.push(gte(captureFrames.ts, from));
    if (to) where.push(lt(captureFrames.ts, to));
    const app = c.req.query('app');
    if (app) where.push(sql`lower(${captureFrames.appName}) = lower(${app})`);
    const domain = c.req.query('domain');
    if (domain) where.push(sql`lower(${captureFrames.domain}) = lower(${domain})`);
    if (cursor) where.push(sql`(${captureFrames.ts}, ${captureFrames.id}) < (${cursor.ts}, ${cursor.id})`);

    const rows = await db
      .select({
        frame_id: captureFrames.id,
        chunk_id: captureFrames.chunkId,
        frame_index: captureFrames.frameIndex,
        ts: captureFrames.ts,
        app_name: captureFrames.appName,
        window_title: captureFrames.windowTitle,
        url: captureFrames.url,
        domain: captureFrames.domain,
        snippet: q
          ? sql<string>`ts_headline('simple', coalesce(${captureFrames.text}, ''), ${query}, 'MaxWords=30, MinWords=10, MaxFragments=1')`
          : sql<string>`left(coalesce(${captureFrames.text}, ''), 200)`,
      })
      .from(captureFrames)
      .where(and(...where))
      .orderBy(desc(captureFrames.ts), desc(captureFrames.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({
      items: page.map((r) => ({ ...r, ts: r.ts.toISOString() })),
      next_cursor: rows.length > limit && last ? encodeCursor(last.ts, last.frame_id) : null,
    });
  });

  // ── Timeline ──────────────────────────────────────────────────────────────
  router.get('/accounts/:accountId/capture/timeline', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    const { ctx } = m;
    const target = c.req.query('user_id') || ctx.userId;
    if (!isUuid(target)) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'user_id must be a UUID');
    const fromQ = parseDate(c, 'from');
    const toQ = parseDate(c, 'to');
    if (fromQ === 'bad' || toQ === 'bad') return err(c, 400, 'CAPTURE_BAD_REQUEST', 'from and to must be ISO dates');
    const to = toQ ?? new Date();
    const from = fromQ ?? new Date(to.getTime() - 24 * 3600_000);
    if (!(await mayRead(c, ctx, target, 'timeline'))) return denied(c);

    const chunks = await db
      .select({
        chunk_id: captureChunks.id,
        started_at: captureChunks.startedAt,
        ended_at: captureChunks.endedAt,
        frame_count: captureChunks.frameCount,
        device_name: tunnelConnections.name,
      })
      .from(captureChunks)
      .innerJoin(captureDevices, eq(captureDevices.id, captureChunks.deviceId))
      .leftJoin(tunnelConnections, eq(tunnelConnections.tunnelId, captureDevices.tunnelId))
      .where(
        and(
          eq(captureChunks.accountId, ctx.accountId),
          eq(captureChunks.userId, target),
          eq(captureChunks.status, 'committed'),
          lt(captureChunks.startedAt, to),
          gte(captureChunks.endedAt, from),
        ),
      )
      .orderBy(desc(captureChunks.startedAt))
      .limit(500);
    // A frame stands for chunk duration / frame count seconds of its app.
    const apps = await db
      .select({
        app_name: captureFrames.appName,
        seconds: sql<number>`sum(extract(epoch from (${captureChunks.endedAt} - ${captureChunks.startedAt})) / greatest(${captureChunks.frameCount}, 1))::float8`,
      })
      .from(captureFrames)
      .innerJoin(captureChunks, eq(captureChunks.id, captureFrames.chunkId))
      .where(
        and(
          eq(captureFrames.accountId, ctx.accountId),
          eq(captureFrames.userId, target),
          gte(captureFrames.ts, from),
          lte(captureFrames.ts, to),
          sql`${captureFrames.appName} is not null`,
        ),
      )
      .groupBy(captureFrames.appName)
      .orderBy(sql`2 desc`)
      .limit(50);
    return c.json({
      chunks: chunks.map((r) => ({ ...r, started_at: r.started_at.toISOString(), ended_at: r.ended_at.toISOString() })),
      apps: apps.map((r) => ({ app_name: r.app_name, seconds: Math.round(r.seconds) })),
    });
  });

  // ── Video ─────────────────────────────────────────────────────────────────
  router.get('/accounts/:accountId/capture/chunks/:chunkId/video', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    const { ctx } = m;
    const chunkId = c.req.param('chunkId');
    if (!isUuid(chunkId)) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'chunkId must be a UUID');
    const [chunk] = await db
      .select({ userId: captureChunks.userId, videoKey: captureChunks.videoKey })
      .from(captureChunks)
      .where(and(eq(captureChunks.id, chunkId), eq(captureChunks.accountId, ctx.accountId), eq(captureChunks.status, 'committed')));
    if (!chunk) return err(c, 404, 'CAPTURE_CHUNK_NOT_FOUND', 'Chunk not found');
    if (!(await mayRead(c, ctx, chunk.userId, 'video'))) return denied(c);
    if (!captureStore.configured) return err(c, 503, 'CAPTURE_STORAGE_UNCONFIGURED', 'Capture storage is not configured');
    const { url, expiresAt } = await captureStore.presignDownload(chunk.videoKey, VIDEO_URL_TTL_SECONDS);
    return c.json({ url, expires_at: expiresAt.toISOString() });
  });

  // ── Frame detail ──────────────────────────────────────────────────────────
  router.get('/accounts/:accountId/capture/frames/:frameId', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    const { ctx } = m;
    const frameId = Number(c.req.param('frameId'));
    if (!Number.isSafeInteger(frameId) || frameId < 1) return err(c, 400, 'CAPTURE_BAD_REQUEST', 'frameId must be a positive integer');
    const [f] = await db
      .select()
      .from(captureFrames)
      .where(and(eq(captureFrames.id, frameId), eq(captureFrames.accountId, ctx.accountId)));
    if (!f) return err(c, 404, 'CAPTURE_FRAME_NOT_FOUND', 'Frame not found');
    if (!(await mayRead(c, ctx, f.userId, 'frame'))) return denied(c);
    return c.json({
      frame_id: f.id,
      chunk_id: f.chunkId,
      user_id: f.userId,
      frame_index: f.frameIndex,
      ts: f.ts.toISOString(),
      app_bundle: f.appBundle,
      app_name: f.appName,
      window_title: f.windowTitle,
      url: f.url,
      domain: f.domain,
      text: f.text,
    });
  });

  // ── Delete own data ───────────────────────────────────────────────────────
  router.delete('/accounts/:accountId/capture/data', async (c) => {
    const m = await member(c);
    if ('response' in m) return m.response;
    const { ctx } = m;
    const from = parseDate(c, 'from');
    const to = parseDate(c, 'to');
    if (from === 'bad' || to === 'bad') return err(c, 400, 'CAPTURE_BAD_REQUEST', 'from and to must be ISO dates');
    if (!captureStore.configured) return err(c, 503, 'CAPTURE_STORAGE_UNCONFIGURED', 'Capture storage is not configured');
    const where = and(
      eq(captureChunks.accountId, ctx.accountId),
      eq(captureChunks.userId, ctx.userId),
      from ? gte(captureChunks.startedAt, from) : undefined,
      to ? lt(captureChunks.startedAt, to) : undefined,
    );
    let deleted = 0;
    for (;;) {
      const rows = await db.select({ id: captureChunks.id, videoKey: captureChunks.videoKey }).from(captureChunks).where(where).limit(500);
      deleted += await deleteChunks(rows);
      if (rows.length < 500) break;
    }
    return c.json({ deleted_chunks: deleted });
  });

  return router;
}

function encodeCursor(ts: Date, id: number): string {
  return Buffer.from(`${ts.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(raw: string | undefined): { ts: Date; id: number } | null {
  if (!raw) return null;
  const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|');
  const ts = new Date(iso ?? '');
  const n = Number(id);
  return Number.isNaN(ts.getTime()) || !Number.isSafeInteger(n) ? null : { ts, id: n };
}
