/**
 * Kortix Capture, project-scoped: `/v1/projects/:projectId/capture/*`.
 *
 * Scoping (captureAccess):
 *   - a person sees their OWN devices and timeline;
 *   - a project manager may read another member (`user_id=`) or the whole
 *     project (devices `scope=project`, people summary); every such read writes
 *     a `capture.member_view` / `capture.project_view` audit row;
 *   - an agent session reads the timeline of the human it acts for (private
 *     session, `on_behalf_of`), never anyone else: `capture.agent_read`;
 *   - a credential that acts for no person (trigger, service account, shared
 *     session) gets 403 `capture_no_human`.
 * Every route needs the project's `capture` flag (403 `feature_disabled`).
 */
import { createRoute, z } from '@hono/zod-openapi';
import { captureDevices, projectSessions, rangeOutputs, timelineChunks, timelineRanges } from '@kortix/db';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { requireFeatureFlag } from '../feature-flags/gate';
import { auth, errors, json } from '../openapi';
import { roleAllows } from '../projects/access';
import { loadProjectForUser } from '../projects/lib/access';
import { projectsApp } from '../projects/lib/app';
import { callerKortixSessionId } from '../projects/lib/caller-session';
import { getRequestOnBehalfOf } from '../projects/lib/on-behalf-of';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import { PolicySchema, isEncrypted, liveState, objectKey, projectPrefix, type Manifest } from './format';
import { readProjectPolicy, writeDevicePolicy, writeProjectPolicy } from './policy';
import { captureStore, captureStoreConfigured } from './store';
import { enqueueRangeProcessing } from './workers';

type Loaded = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;

interface Access {
  loaded: Loaded;
  projectId: string;
  accountId: string;
  /** The human the caller is (or acts for). */
  viewer: string;
  /** Whose data this request reads; null = the whole project (managers). */
  subject: string | null;
  manager: boolean;
  sessionId: string | null;
}

const refuse = (c: Context, status: 400 | 403 | 404 | 503, code: string, error: string) => c.json({ error, code }, status);

async function captureAccess(
  c: Context,
  opts: { userId?: string | null; projectWide?: boolean } = {},
): Promise<Access | Response> {
  const projectId = c.req.param('projectId')!;
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  const gate = requireFeatureFlag(c, loaded.row.metadata, 'capture');
  if (gate) return gate;
  const sessionId = callerKortixSessionId(c);
  const authType = c.get('authType') as string | undefined;
  let viewer: string | null = null;
  if (sessionId) {
    // An agent session acts for the person who started it, only in a private session.
    const onBehalf = getRequestOnBehalfOf(c);
    const [session] = onBehalf
      ? await db
          .select({ visibility: projectSessions.visibility })
          .from(projectSessions)
          .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
          .limit(1)
      : [];
    if (session?.visibility === 'private') viewer = onBehalf;
  } else if (authType === 'supabase' || authType === 'pat' || authType === 'oauth') {
    viewer = loaded.userId;
  }
  if (!viewer) return refuse(c, 403, 'capture_no_human', 'This credential does not act for a person, so it has no capture timeline');
  const manager = !sessionId && roleAllows(loaded.effectiveRole, 'manage');
  const subject = opts.projectWide ? null : (opts.userId ?? viewer);
  const access: Access = { loaded, projectId, accountId: loaded.row.accountId, viewer, subject, manager, sessionId };
  const audit = (action: string, resourceId: string | null) =>
    recordAuditEvent({
      accountId: access.accountId,
      projectId,
      sessionId,
      actorUserId: viewer,
      actorType: sessionId ? 'agent' : 'human',
      onBehalfOfUserId: sessionId ? viewer : null,
      action,
      resourceType: 'capture_member',
      resourceId,
      outcome: 'success',
      metadata: { path: c.req.path },
    });
  if (subject !== viewer) {
    if (!manager) return refuse(c, 403, 'capture_forbidden', 'Only a project manager can read another member’s capture data');
    await audit(subject ? 'capture.member_view' : 'capture.project_view', subject);
  } else if (sessionId) {
    await audit('capture.agent_read', viewer);
  }
  return access;
}

const isResponse = (value: unknown): value is Response => value instanceof Response;

/** Raw SQL rows carry Postgres timestamp text; the API answers ISO 8601 like every other route. */
function isoRows<T extends Record<string, any>>(rows: Iterable<T>): T[] {
  return Array.from(rows, (row) => {
    const out: Record<string, any> = { ...row };
    for (const key of ['ts', 'end_at', 'start_at']) if (out[key] != null) out[key] = new Date(out[key]).toISOString();
    return out as T;
  });
}

/** `[from, to)` from `day=YYYY-MM-DD` (UTC) or `from`/`to` ISO instants; default today. */
function window(c: Context): { from: Date; to: Date } | null {
  const day = c.req.query('day');
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const from = new Date(`${day}T00:00:00.000Z`);
    return Number.isNaN(from.getTime()) ? null : { from, to: new Date(from.getTime() + 86_400_000) };
  }
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  const now = Date.now();
  const from = fromRaw ? new Date(fromRaw) : new Date(new Date(now).setUTCHours(0, 0, 0, 0));
  const to = toRaw ? new Date(toRaw) : new Date(from.getTime() + 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
  if (to.getTime() - from.getTime() > 31 * 86_400_000) return null;
  return { from, to };
}

const params = z.object({ projectId: z.string().uuid() });
const ok = (description: string) => ({ 200: json(z.any(), description), ...errors(400, 403, 404) });
const tags = ['capture'];

function deviceView(device: typeof captureDevices.$inferSelect, now = Date.now()) {
  return {
    device_id: device.deviceId,
    user_id: device.userId,
    name: device.name,
    os: device.os,
    os_version: device.osVersion,
    arch: device.arch,
    app_version: device.appVersion,
    live: {
      state: liveState(device.status, now),
      status: device.status,
      reported_at: device.statusReportedAt?.toISOString() ?? null,
    },
    policy_override: device.policyOverride ? PolicySchema.parse(device.policyOverride) : null,
    last_credentials_at: device.lastCredentialsAt?.toISOString() ?? null,
    revoked_at: device.revokedAt?.toISOString() ?? null,
    created_at: device.createdAt.toISOString(),
  };
}

async function loadDevice(c: Context, access: Access, deviceId: string) {
  const [device] = await db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.deviceId, deviceId), eq(captureDevices.projectId, access.projectId)))
    .limit(1);
  // Someone else's device is "not found" to a member: no existence leak.
  if (!device || (device.userId !== access.viewer && !access.manager)) return null;
  return device;
}

// ─── Devices ─────────────────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/devices',
    tags,
    summary: 'Capture devices with live status: yours, a member’s (managers), or the project’s (managers, scope=project)',
    ...auth,
    request: { params, query: z.object({ user_id: z.string().uuid().optional(), scope: z.enum(['mine', 'project']).optional() }) },
    responses: ok('The devices'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id'), projectWide: c.req.query('scope') === 'project' });
    if (isResponse(access)) return access;
    const rows = await db
      .select()
      .from(captureDevices)
      .where(
        and(
          eq(captureDevices.projectId, access.projectId),
          ...(access.subject ? [eq(captureDevices.userId, access.subject)] : []),
        ),
      )
      .orderBy(desc(captureDevices.updatedAt));
    return c.json({ devices: rows.map((d) => deviceView(d)) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/capture/devices/{deviceId}',
    tags,
    summary: 'Revoke a capture device: its token stops working and it can no longer get credentials',
    ...auth,
    request: { params: params.extend({ deviceId: z.string().uuid() }) },
    responses: ok('The revoked device'),
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot revoke a capture device');
    const device = await loadDevice(c, access, c.req.param('deviceId'));
    if (!device) return c.json({ error: 'Not found' }, 404);
    const [revoked] = await db
      .update(captureDevices)
      .set({ revokedAt: sql`coalesce(${captureDevices.revokedAt}, now())`, revokedBy: access.viewer, tokenHash: null, updatedAt: sql`now()` })
      .where(eq(captureDevices.deviceId, device.deviceId))
      .returning();
    return c.json(deviceView(revoked!));
  },
);

// ─── Policy ──────────────────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/policy',
    tags,
    summary: 'The project capture policy (layers, privacy, retention, pause, notice)',
    ...auth,
    request: { params },
    responses: ok('The policy'),
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    return c.json(await readProjectPolicy(access.projectId));
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/capture/policy',
    tags,
    summary: 'Set the project capture policy (managers); publishes <prefix>/policy.json',
    ...auth,
    request: { params, body: { content: { 'application/json': { schema: z.object({ policy: z.record(z.string(), z.any()) }) } } } },
    responses: { ...ok('The stored policy'), ...errors(503) },
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    if (!access.manager) return refuse(c, 403, 'capture_forbidden', 'Only a project manager can change the capture policy');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const parsed = PolicySchema.safeParse(c.req.valid('json').policy);
    if (!parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    return c.json(await writeProjectPolicy(access, parsed.data, access.viewer));
  },
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/capture/devices/{deviceId}/policy',
    tags,
    summary: 'Set or clear (null) one device’s policy override (managers); publishes <prefix>/<device_id>/policy.json',
    ...auth,
    request: {
      params: params.extend({ deviceId: z.string().uuid() }),
      body: { content: { 'application/json': { schema: z.object({ policy: z.record(z.string(), z.any()).nullable() }) } } },
    },
    responses: { ...ok('The device'), ...errors(503) },
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    if (!access.manager) return refuse(c, 403, 'capture_forbidden', 'Only a project manager can change a device policy');
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const device = await loadDevice(c, access, c.req.param('deviceId'));
    if (!device) return c.json({ error: 'Not found' }, 404);
    const raw = c.req.valid('json').policy;
    const parsed = raw === null ? null : PolicySchema.safeParse(raw);
    if (parsed && !parsed.success) return refuse(c, 400, 'capture_policy_invalid', parsed.error.issues[0]?.message ?? 'Invalid policy');
    await writeDevicePolicy(access, device.deviceId, parsed ? parsed.data : null);
    const [fresh] = await db.select().from(captureDevices).where(eq(captureDevices.deviceId, device.deviceId));
    return c.json(deviceView(fresh!));
  },
);

// ─── Timeline ────────────────────────────────────────────────────────────────

const subjectQuery = z.object({
  user_id: z.string().uuid().optional(),
  device_id: z.string().uuid().optional(),
  day: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/** A timestamptz parameter. A bare Date in raw SQL is sent as its local `toString()`. */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;

const deviceFilter = (column: string, deviceId: string | undefined) =>
  deviceId ? sql` AND ${sql.raw(column)} = ${deviceId}::uuid` : sql``;

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/timeline',
    tags,
    summary: 'One person’s timeline for a day or window: activity runs (app + window), indexed items, and ranges',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The timeline'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id') });
    if (isResponse(access)) return access;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', 'Give day=YYYY-MM-DD, or from/to ISO instants at most 31 days apart');
    const deviceId = c.req.query('device_id');
    const subject = access.subject!;
    // Runs: consecutive frames of one device with the same app and window, no gap over 2 minutes.
    const runs = isoRows(
      await db.execute<Record<string, unknown>>(sql`
        SELECT device_id, app, title, (array_agg(url ORDER BY ts))[1] AS url,
               min(ts) AS start_at, max(ts) AS end_at, count(*)::int AS frames
          FROM (SELECT *, sum(brk) OVER (PARTITION BY device_id ORDER BY ts) AS grp
                  FROM (SELECT device_id, ts, app, title, url,
                               CASE WHEN app IS NOT DISTINCT FROM lag(app) OVER w
                                     AND title IS NOT DISTINCT FROM lag(title) OVER w
                                     AND ts - lag(ts) OVER w < interval '2 minutes'
                                    THEN 0 ELSE 1 END AS brk
                          FROM kortix.timeline_frames
                         WHERE project_id = ${access.projectId}::uuid AND user_id = ${subject}::uuid
                           AND ts >= ${at(span.from)} AND ts < ${at(span.to)} AND NOT inactive
                           ${deviceFilter('device_id', deviceId)}
                        WINDOW w AS (PARTITION BY device_id ORDER BY ts)) marked) grouped
         GROUP BY device_id, grp, app, title
         ORDER BY min(ts)
         LIMIT 5000`),
    );
    const chunks = await db
      .select({
        chunk_id: timelineChunks.chunkId,
        device_id: timelineChunks.deviceId,
        kind: timelineChunks.kind,
        start_at: timelineChunks.startAt,
        end_at: timelineChunks.endAt,
        item_count: timelineChunks.itemCount,
        encrypted: timelineChunks.encrypted,
      })
      .from(timelineChunks)
      .where(
        and(
          eq(timelineChunks.projectId, access.projectId),
          eq(timelineChunks.userId, subject),
          gte(timelineChunks.endAt, span.from),
          lte(timelineChunks.startAt, span.to),
          ...(deviceId ? [eq(timelineChunks.deviceId, deviceId)] : []),
        ),
      )
      .orderBy(asc(timelineChunks.startAt))
      .limit(5000);
    const ranges = await rangesFor(access.projectId, subject, span);
    return c.json({ user_id: subject, from: span.from.toISOString(), to: span.to.toISOString(), runs, chunks, ranges });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/timeline/items',
    tags,
    summary: 'Frames, actions and audio lines of one person in a window (at most 500 of each, oldest first)',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The items'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id') });
    if (isResponse(access)) return access;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', 'Give day=YYYY-MM-DD, or from/to ISO instants at most 31 days apart');
    const deviceId = c.req.query('device_id');
    const where = sql`project_id = ${access.projectId}::uuid AND user_id = ${access.subject!}::uuid AND ts >= ${at(span.from)} AND ts < ${at(span.to)} ${deviceFilter('device_id', deviceId)}`;
    const [frames, actions, audio] = await Promise.all([
      db.execute(sql`SELECT frame_id, ts, device_id, chunk_id, frame_index, app, bundle_id, title, url, domain, ocr_text, inactive FROM kortix.timeline_frames WHERE ${where} ORDER BY ts LIMIT 500`),
      db.execute(sql`SELECT action_id, ts, device_id, chunk_id, kind, app, window_title, description, target, screenshot FROM kortix.timeline_actions WHERE ${where} ORDER BY ts LIMIT 500`),
      db.execute(sql`SELECT line_id, ts, end_at, device_id, chunk_id, text FROM kortix.timeline_audio WHERE ${where} ORDER BY ts LIMIT 500`),
    ]);
    return c.json({ user_id: access.subject, from: span.from.toISOString(), to: span.to.toISOString(), frames: isoRows(frames as Iterable<Record<string, any>>), actions: isoRows(actions as Iterable<Record<string, any>>), audio: isoRows(audio as Iterable<Record<string, any>>) });
  },
);

// ─── Search ──────────────────────────────────────────────────────────────────

// These expressions match the GIN indexes in kortix.ts exactly, so the planner uses them.
const FRAME_DOC = sql.raw(`to_tsvector('simple'::regconfig, coalesce("app", '') || ' ' || coalesce("title", '') || ' ' || coalesce("url", '') || ' ' || coalesce("ocr_text", ''))`);
const ACTION_DOC = sql.raw(`to_tsvector('simple'::regconfig, coalesce("kind", '') || ' ' || coalesce("app", '') || ' ' || coalesce("window_title", '') || ' ' || coalesce("description", ''))`);
const AUDIO_DOC = sql.raw(`to_tsvector('simple'::regconfig, coalesce("text", ''))`);

/** ±80 characters around the first query word found in `text`. */
export function snippet(text: string | null, q: string): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const hits = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, at - 80);
  return `${start > 0 ? '…' : ''}${flat.slice(start, at + 80)}${at + 80 < flat.length ? '…' : ''}`;
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/search',
    tags,
    summary: 'Full-text search of one person’s timeline: screen (app, window, URL, on-screen text; one hit per chunk and window), actions and audio',
    ...auth,
    request: {
      params,
      query: subjectQuery.extend({
        q: z.string().min(1),
        kinds: z.string().optional().describe('Comma list of screen, actions, audio (default all)'),
        app: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
    responses: ok('Hits, newest first'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id') });
    if (isResponse(access)) return access;
    const q = String(c.req.query('q') ?? '').trim().slice(0, 500);
    if (!q) return refuse(c, 400, 'capture_bad_query', 'q is required');
    const from = c.req.query('from') ? new Date(c.req.query('from')) : new Date(0);
    const to = c.req.query('to') ? new Date(c.req.query('to')) : new Date(Date.now() + 86_400_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return refuse(c, 400, 'capture_bad_window', 'from/to must be ISO instants');
    const kinds = new Set(String(c.req.query('kinds') ?? 'screen,actions,audio').split(',').map((k) => k.trim()));
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100);
    const app = c.req.query('app');
    const deviceId = c.req.query('device_id');
    const scope = sql`project_id = ${access.projectId}::uuid AND user_id = ${access.subject!}::uuid AND ts >= ${at(from)} AND ts < ${at(to)} ${deviceFilter('device_id', deviceId)} ${app ? sql` AND lower(app) = lower(${app})` : sql``}`;
    const query = sql`websearch_to_tsquery('simple', ${q})`;
    const parts = [
      kinds.has('screen') &&
        sql`(SELECT * FROM (SELECT DISTINCT ON (chunk_id, title) 'screen' AS kind, frame_id AS id, ts, device_id, chunk_id, app, title, url, ocr_text AS text FROM kortix.timeline_frames WHERE ${scope} AND ${FRAME_DOC} @@ ${query} ORDER BY chunk_id, title, ts DESC) per_window ORDER BY ts DESC LIMIT ${limit})`,
      kinds.has('actions') &&
        sql`(SELECT 'actions' AS kind, action_id AS id, ts, device_id, chunk_id, app, window_title AS title, NULL AS url, description AS text FROM kortix.timeline_actions WHERE ${scope} AND ${ACTION_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${limit})`,
      kinds.has('audio') &&
        sql`(SELECT 'audio' AS kind, line_id AS id, ts, device_id, chunk_id, NULL AS app, NULL AS title, NULL AS url, text FROM kortix.timeline_audio WHERE ${scope} AND ${AUDIO_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${limit})`,
    ].filter(Boolean) as ReturnType<typeof sql>[];
    if (!parts.length) return refuse(c, 400, 'capture_bad_query', 'kinds must name screen, actions or audio');
    const rows = isoRows(
      await db.execute<Record<string, any>>(sql`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) hits ORDER BY ts DESC LIMIT ${limit}`),
    );
    return c.json({
      user_id: access.subject,
      q,
      hits: rows.map(({ text, ...row }) => ({ ...row, snippet: snippet(text, q) })),
    });
  },
);

// ─── Media ───────────────────────────────────────────────────────────────────

const MEDIA_TTL_SECONDS = 300;

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/frames/{frameId}',
    tags,
    summary: 'One frame with its full on-screen text and a signed, short-lived URL of its video chunk',
    ...auth,
    request: { params: params.extend({ frameId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional() }) },
    responses: ok('The frame'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id') });
    if (isResponse(access)) return access;
    const [frame] = isoRows(
      await db.execute<Record<string, any>>(
        sql`SELECT * FROM kortix.timeline_frames WHERE frame_id = ${c.req.param('frameId')}::uuid AND project_id = ${access.projectId}::uuid AND user_id = ${access.subject!}::uuid LIMIT 1`,
      ),
    );
    if (!frame) return c.json({ error: 'Not found' }, 404);
    const [chunk] = await db.select().from(timelineChunks).where(eq(timelineChunks.chunkId, frame.chunk_id)).limit(1);
    const video = chunk ? await mediaUrl(chunk, 'video') : null;
    return c.json({ frame, video: video && { ...video, offset_ms: new Date(frame.ts).getTime() - chunk!.startAt.getTime() } });
  },
);

async function mediaUrl(chunk: typeof timelineChunks.$inferSelect, role: string) {
  const info = (chunk.manifest as Manifest).objects?.[role];
  if (!info || !captureStoreConfigured()) return null;
  const key = objectKey(projectPrefix(chunk.accountId, chunk.projectId), chunk.deviceId, info.key);
  if (!key) return null;
  const signed = await captureStore.presignDownload(key, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString(), encrypted: isEncrypted(chunk.manifest as Manifest) };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/chunks/{chunkId}/media',
    tags,
    summary: 'Signed, short-lived URLs of an indexed item’s media (video or audio)',
    ...auth,
    request: { params: params.extend({ chunkId: z.string().uuid() }), query: z.object({ user_id: z.string().uuid().optional() }) },
    responses: ok('The URLs'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id') });
    if (isResponse(access)) return access;
    const [chunk] = await db
      .select()
      .from(timelineChunks)
      .where(and(eq(timelineChunks.chunkId, c.req.param('chunkId')), eq(timelineChunks.projectId, access.projectId), eq(timelineChunks.userId, access.subject!)))
      .limit(1);
    if (!chunk) return c.json({ error: 'Not found' }, 404);
    return c.json({ chunk_id: chunk.chunkId, kind: chunk.kind, video: await mediaUrl(chunk, 'video'), audio: await mediaUrl(chunk, 'audio') });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/devices/{deviceId}/assets/{name}',
    tags,
    summary: 'A signed, short-lived URL of one content-addressed asset (action screenshot, icon)',
    ...auth,
    request: { params: params.extend({ deviceId: z.string().uuid(), name: z.string() }) },
    responses: ok('The URL'),
  }),
  async (c: any) => {
    const name = c.req.param('name');
    if (!/^(sha256-)?[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(name)) return refuse(c, 400, 'capture_bad_asset', 'Asset names are sha256-<hex>.<ext>');
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    const device = await loadDevice(c, access, c.req.param('deviceId'));
    if (!device) return c.json({ error: 'Not found' }, 404);
    if (device.userId !== access.viewer) {
      await recordAuditEvent({ accountId: access.accountId, projectId: access.projectId, actorUserId: access.viewer, actorType: 'human', action: 'capture.member_view', resourceType: 'capture_member', resourceId: device.userId, outcome: 'success', metadata: { path: c.req.path } });
    }
    if (!captureStoreConfigured()) return refuse(c, 503, 'capture_store_unavailable', 'No capture store is configured');
    const signed = await captureStore.presignDownload(`${projectPrefix(access.accountId, access.projectId)}/${device.deviceId}/assets/${name}`, MEDIA_TTL_SECONDS);
    return c.json({ url: signed.url, expires_at: signed.expiresAt.toISOString() });
  },
);

// ─── Ranges ──────────────────────────────────────────────────────────────────

async function rangesFor(projectId: string, userId: string, span: { from: Date; to: Date }) {
  const rows = await db
    .select()
    .from(timelineRanges)
    .where(and(eq(timelineRanges.projectId, projectId), eq(timelineRanges.userId, userId), gte(timelineRanges.endAt, span.from), lte(timelineRanges.startAt, span.to)))
    .orderBy(asc(timelineRanges.startAt))
    .limit(1000);
  return rows.map(rangeView);
}

function rangeView(range: typeof timelineRanges.$inferSelect) {
  return {
    range_id: range.rangeId,
    user_id: range.userId,
    device_id: range.deviceId,
    source: range.source,
    title: range.title,
    start_at: range.startAt.toISOString(),
    end_at: range.endAt.toISOString(),
    status: range.status,
    created_by: range.createdBy,
    created_at: range.createdAt.toISOString(),
  };
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/ranges',
    tags,
    summary: 'One person’s ranges (detected activity sessions and saved spans) in a window',
    ...auth,
    request: { params, query: subjectQuery },
    responses: ok('The ranges'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { userId: c.req.query('user_id') });
    if (isResponse(access)) return access;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', 'Give day=YYYY-MM-DD, or from/to ISO instants at most 31 days apart');
    return c.json({ ranges: await rangesFor(access.projectId, access.subject!, span) });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/capture/ranges',
    tags,
    summary: 'Save a span of your own timeline as a range and process it',
    ...auth,
    request: {
      params,
      body: {
        content: {
          'application/json': {
            schema: z.object({ start_at: z.string(), end_at: z.string(), title: z.string().max(200).optional(), device_id: z.string().uuid().optional() }),
          },
        },
      },
    },
    responses: { 201: json(z.any(), 'The saved range'), ...errors(400, 403, 404) },
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    const body = c.req.valid('json');
    const startAt = new Date(body.start_at);
    const endAt = new Date(body.end_at);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt || endAt.getTime() - startAt.getTime() > 24 * 3_600_000) {
      return refuse(c, 400, 'capture_bad_window', 'start_at < end_at, at most 24 hours apart');
    }
    if (body.device_id) {
      const device = await loadDevice(c, access, body.device_id);
      if (!device || device.userId !== access.viewer) return c.json({ error: 'Not found' }, 404);
    }
    const [range] = await db
      .insert(timelineRanges)
      .values({
        accountId: access.accountId,
        projectId: access.projectId,
        userId: access.viewer,
        deviceId: body.device_id ?? null,
        source: 'saved',
        title: body.title?.trim() || null,
        startAt,
        endAt,
        status: 'closed',
        createdBy: access.viewer,
      })
      .returning();
    await enqueueRangeProcessing(range!);
    return c.json(rangeView(range!), 201);
  },
);

async function loadRange(c: Context, access: Access) {
  const [range] = await db
    .select()
    .from(timelineRanges)
    .where(and(eq(timelineRanges.rangeId, c.req.param('rangeId')!), eq(timelineRanges.projectId, access.projectId)))
    .limit(1);
  if (!range) return null;
  if (range.userId !== access.viewer) {
    if (!access.manager) return null;
    await recordAuditEvent({ accountId: access.accountId, projectId: access.projectId, actorUserId: access.viewer, actorType: 'human', action: 'capture.member_view', resourceType: 'capture_member', resourceId: range.userId, outcome: 'success', metadata: { path: c.req.path } });
  }
  return range;
}

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/ranges/{rangeId}',
    tags,
    summary: 'One range with its processing outputs (segmentation, transcript, annotation)',
    ...auth,
    request: { params: params.extend({ rangeId: z.string().uuid() }) },
    responses: ok('The range'),
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    const range = await loadRange(c, access);
    if (!range) return c.json({ error: 'Not found' }, 404);
    const outputs = await db.select().from(rangeOutputs).where(eq(rangeOutputs.rangeId, range.rangeId)).orderBy(asc(rangeOutputs.createdAt));
    return c.json({
      ...rangeView(range),
      outputs: outputs.map((o) => ({ kind: o.kind, status: o.status, model: o.model, output: o.output, usage: o.usage, error: o.error, updated_at: o.updatedAt.toISOString() })),
    });
  },
);

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/capture/ranges/{rangeId}/process',
    tags,
    summary: 'Run the range pipelines again',
    ...auth,
    request: { params: params.extend({ rangeId: z.string().uuid() }) },
    responses: { 202: json(z.any(), 'Queued'), ...errors(403, 404) },
  }),
  async (c: any) => {
    const access = await captureAccess(c);
    if (isResponse(access)) return access;
    if (access.sessionId) return refuse(c, 403, 'capture_forbidden', 'An agent cannot start range processing');
    const range = await loadRange(c, access);
    if (!range) return c.json({ error: 'Not found' }, 404);
    await db.update(timelineRanges).set({ status: 'closed', updatedAt: sql`now()` }).where(eq(timelineRanges.rangeId, range.rangeId));
    const queued = await enqueueRangeProcessing(range, `:rerun-${Date.now()}`);
    return c.json({ range_id: range.rangeId, queued }, 202);
  },
);

// ─── People (managers) ───────────────────────────────────────────────────────

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/capture/people',
    tags,
    summary: 'Per member: active time, time per app, ranges and devices in a window (project managers)',
    ...auth,
    request: { params, query: z.object({ day: z.string().optional(), from: z.string().optional(), to: z.string().optional() }) },
    responses: ok('The summary'),
  }),
  async (c: any) => {
    const access = await captureAccess(c, { projectWide: true });
    if (isResponse(access)) return access;
    const span = window(c);
    if (!span) return refuse(c, 400, 'capture_bad_window', 'Give day=YYYY-MM-DD, or from/to ISO instants at most 31 days apart');
    // A frame's time runs until the next frame of its device, capped at 60 s (a pause is not work).
    const perApp = Array.from(
      await db.execute<{ user_id: string; app: string | null; seconds: number }>(sql`
        SELECT user_id, app, round(sum(LEAST(EXTRACT(EPOCH FROM (next_ts - ts)), 60)))::int AS seconds
          FROM (SELECT user_id, app, ts, inactive, lead(ts) OVER (PARTITION BY device_id ORDER BY ts) AS next_ts
                  FROM kortix.timeline_frames
                 WHERE project_id = ${access.projectId}::uuid AND ts >= ${at(span.from)} AND ts < ${at(span.to)}) f
         WHERE NOT inactive AND next_ts IS NOT NULL
         GROUP BY user_id, app`),
    );
    const ranges = Array.from(
      await db.execute<{ user_id: string; ranges: number }>(sql`
        SELECT user_id, count(*)::int AS ranges FROM kortix.timeline_ranges
         WHERE project_id = ${access.projectId}::uuid AND end_at >= ${at(span.from)} AND start_at < ${at(span.to)}
         GROUP BY user_id`),
    );
    const devices = await db
      .select({ userId: captureDevices.userId, count: sql<number>`count(*)::int` })
      .from(captureDevices)
      .where(and(eq(captureDevices.projectId, access.projectId), isNull(captureDevices.revokedAt)))
      .groupBy(captureDevices.userId);
    const people = new Map<string, { user_id: string; active_seconds: number; apps: Array<{ app: string | null; seconds: number }>; ranges: number; devices: number }>();
    const person = (userId: string) => {
      if (!people.has(userId)) people.set(userId, { user_id: userId, active_seconds: 0, apps: [], ranges: 0, devices: 0 });
      return people.get(userId)!;
    };
    for (const row of perApp) {
      const p = person(row.user_id);
      p.active_seconds += Number(row.seconds);
      p.apps.push({ app: row.app, seconds: Number(row.seconds) });
    }
    for (const row of ranges) person(row.user_id).ranges = Number(row.ranges);
    for (const row of devices) person(row.userId).devices = Number(row.count);
    for (const p of people.values()) p.apps.sort((a, b) => b.seconds - a.seconds);
    return c.json({ from: span.from.toISOString(), to: span.to.toISOString(), people: [...people.values()].sort((a, b) => b.active_seconds - a.active_seconds) });
  },
);
