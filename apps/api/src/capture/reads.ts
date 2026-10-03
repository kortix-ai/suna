/**
 * Kortix Capture timeline reads and writes behind project-routes.ts: devices,
 * the timeline, items, search, media, ranges, the people summary. Every query
 * is bound to (project, person); the route decides who may ask.
 */
import { captureDevices, projectSessions, rangeOutputs, timelineChunks, timelineRanges } from '@kortix/db';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { PolicySchema, isEncrypted, liveState, objectKey, projectPrefix, type Manifest } from './format';
import { captureStore, captureStoreConfigured } from './store';

export type Device = typeof captureDevices.$inferSelect;
export type Range = typeof timelineRanges.$inferSelect;
export type Chunk = typeof timelineChunks.$inferSelect;
export interface Span {
  from: Date;
  to: Date;
}

/** A timestamptz parameter. A bare Date in raw SQL is sent as its local `toString()`. */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const onDevice = (deviceId: string | undefined) => (deviceId ? sql` AND device_id = ${deviceId}::uuid` : sql``);

/** Raw SQL rows carry Postgres timestamp text; the API answers ISO 8601 like every other route. */
export function isoRows<T extends Record<string, unknown>>(rows: Iterable<T>): T[] {
  return Array.from(rows, (row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of ['ts', 'end_at', 'start_at']) {
      if (out[key] != null) out[key] = new Date(out[key] as string).toISOString();
    }
    return out as T;
  });
}

export async function sessionVisibility(sessionId: string, projectId: string): Promise<string | null> {
  const [session] = await db
    .select({ visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return session?.visibility ?? null;
}

// ─── Devices ─────────────────────────────────────────────────────────────────

export function deviceView(device: Device, now = Date.now()) {
  return {
    device_id: device.deviceId,
    user_id: device.userId,
    name: device.name,
    os: device.os,
    os_version: device.osVersion,
    arch: device.arch,
    app_version: device.appVersion,
    live: { state: liveState(device.status, now), status: device.status, reported_at: device.statusReportedAt?.toISOString() ?? null },
    policy_override: device.policyOverride ? PolicySchema.parse(device.policyOverride) : null,
    last_credentials_at: device.lastCredentialsAt?.toISOString() ?? null,
    revoked_at: device.revokedAt?.toISOString() ?? null,
    created_at: device.createdAt.toISOString(),
  };
}

export async function listDevices(projectId: string, userId: string | null): Promise<Device[]> {
  return db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.projectId, projectId), ...(userId ? [eq(captureDevices.userId, userId)] : [])))
    .orderBy(desc(captureDevices.updatedAt));
}

export async function deviceInProject(projectId: string, deviceId: string): Promise<Device | null> {
  const [device] = await db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.deviceId, deviceId), eq(captureDevices.projectId, projectId)))
    .limit(1);
  return device ?? null;
}

export async function revokeDevice(deviceId: string, by: string): Promise<Device> {
  const [revoked] = await db
    .update(captureDevices)
    .set({ revokedAt: sql`coalesce(${captureDevices.revokedAt}, now())`, revokedBy: by, tokenHash: null, updatedAt: sql`now()` })
    .where(eq(captureDevices.deviceId, deviceId))
    .returning();
  return revoked!;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

/** Consecutive frames of one device with the same app and window title, no gap over 2 minutes. */
export async function timelineRuns(projectId: string, userId: string, span: Span, deviceId?: string) {
  return isoRows(
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
                       WHERE project_id = ${projectId}::uuid AND user_id = ${userId}::uuid
                         AND ts >= ${at(span.from)} AND ts < ${at(span.to)} AND NOT inactive ${onDevice(deviceId)}
                      WINDOW w AS (PARTITION BY device_id ORDER BY ts)) marked) grouped
       GROUP BY device_id, grp, app, title
       ORDER BY min(ts)
       LIMIT 5000`),
  );
}

export async function timelineChunksIn(projectId: string, userId: string, span: Span, deviceId?: string) {
  return db
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
        eq(timelineChunks.projectId, projectId),
        eq(timelineChunks.userId, userId),
        gte(timelineChunks.endAt, span.from),
        lte(timelineChunks.startAt, span.to),
        ...(deviceId ? [eq(timelineChunks.deviceId, deviceId)] : []),
      ),
    )
    .orderBy(asc(timelineChunks.startAt))
    .limit(5000);
}

export async function timelineItems(projectId: string, userId: string, span: Span, deviceId?: string) {
  const where = sql`project_id = ${projectId}::uuid AND user_id = ${userId}::uuid AND ts >= ${at(span.from)} AND ts < ${at(span.to)} ${onDevice(deviceId)}`;
  const [frames, actions, audio] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`SELECT frame_id, ts, device_id, chunk_id, frame_index, app, bundle_id, title, url, domain, ocr_text, inactive FROM kortix.timeline_frames WHERE ${where} ORDER BY ts LIMIT 500`),
    db.execute<Record<string, unknown>>(sql`SELECT action_id, ts, device_id, chunk_id, kind, app, window_title, description, target, screenshot FROM kortix.timeline_actions WHERE ${where} ORDER BY ts LIMIT 500`),
    db.execute<Record<string, unknown>>(sql`SELECT line_id, ts, end_at, device_id, chunk_id, text FROM kortix.timeline_audio WHERE ${where} ORDER BY ts LIMIT 500`),
  ]);
  return { frames: isoRows(frames), actions: isoRows(actions), audio: isoRows(audio) };
}

// ─── Search ──────────────────────────────────────────────────────────────────

// These expressions match the GIN indexes in kortix.ts exactly, so the planner uses them.
const FRAME_DOC = sql.raw(`to_tsvector('simple'::regconfig, coalesce("app", '') || ' ' || coalesce("title", '') || ' ' || coalesce("url", '') || ' ' || coalesce("ocr_text", ''))`);
const ACTION_DOC = sql.raw(`to_tsvector('simple'::regconfig, coalesce("kind", '') || ' ' || coalesce("app", '') || ' ' || coalesce("window_title", '') || ' ' || coalesce("description", ''))`);
const AUDIO_DOC = sql.raw(`to_tsvector('simple'::regconfig, coalesce("text", ''))`);

export type SearchKind = 'screen' | 'actions' | 'audio';

/** ±80 characters around the first query word found in `text`. */
export function snippet(text: string | null, q: string): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const hits = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const center = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, center - 80);
  return `${start > 0 ? '…' : ''}${flat.slice(start, center + 80)}${center + 80 < flat.length ? '…' : ''}`;
}

/** Newest first; one screen hit per (chunk, window title), so a still screen is one hit, not 15. */
export async function searchTimeline(
  projectId: string,
  userId: string,
  opts: { q: string; from: Date; to: Date; kinds: Set<SearchKind>; app?: string; deviceId?: string; limit: number },
) {
  const scope = sql`project_id = ${projectId}::uuid AND user_id = ${userId}::uuid AND ts >= ${at(opts.from)} AND ts < ${at(opts.to)} ${onDevice(opts.deviceId)} ${opts.app ? sql` AND lower(app) = lower(${opts.app})` : sql``}`;
  const query = sql`websearch_to_tsquery('simple', ${opts.q})`;
  const parts = [
    opts.kinds.has('screen') &&
      sql`(SELECT * FROM (SELECT DISTINCT ON (chunk_id, title) 'screen' AS kind, frame_id AS id, ts, device_id, chunk_id, app, title, url, ocr_text AS text FROM kortix.timeline_frames WHERE ${scope} AND ${FRAME_DOC} @@ ${query} ORDER BY chunk_id, title, ts DESC) per_window ORDER BY ts DESC LIMIT ${opts.limit})`,
    opts.kinds.has('actions') &&
      sql`(SELECT 'actions' AS kind, action_id AS id, ts, device_id, chunk_id, app, window_title AS title, NULL AS url, description AS text FROM kortix.timeline_actions WHERE ${scope} AND ${ACTION_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${opts.limit})`,
    opts.kinds.has('audio') &&
      sql`(SELECT 'audio' AS kind, line_id AS id, ts, device_id, chunk_id, NULL AS app, NULL AS title, NULL AS url, text FROM kortix.timeline_audio WHERE ${scope} AND ${AUDIO_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${opts.limit})`,
  ].filter(Boolean) as ReturnType<typeof sql>[];
  if (parts.length === 0) return [];
  const rows = isoRows(
    await db.execute<Record<string, unknown>>(sql`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) hits ORDER BY ts DESC LIMIT ${opts.limit}`),
  );
  return rows.map(({ text, ...row }) => ({ ...row, snippet: snippet(text as string | null, opts.q) }));
}

// ─── Media ───────────────────────────────────────────────────────────────────

const MEDIA_TTL_SECONDS = 300;

export async function frameOf(projectId: string, userId: string, frameId: string) {
  const [frame] = isoRows(
    await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM kortix.timeline_frames WHERE frame_id = ${frameId}::uuid AND project_id = ${projectId}::uuid AND user_id = ${userId}::uuid LIMIT 1`,
    ),
  );
  if (!frame) return null;
  const [chunk] = await db.select().from(timelineChunks).where(eq(timelineChunks.chunkId, frame.chunk_id as string)).limit(1);
  return { frame, chunk: chunk ?? null };
}

export async function chunkOf(projectId: string, userId: string, chunkId: string): Promise<Chunk | null> {
  const [chunk] = await db
    .select()
    .from(timelineChunks)
    .where(and(eq(timelineChunks.chunkId, chunkId), eq(timelineChunks.projectId, projectId), eq(timelineChunks.userId, userId)))
    .limit(1);
  return chunk ?? null;
}

/** A 5-minute signed GET of one object of an indexed item, or null. */
export async function mediaUrl(chunk: Chunk, role: string) {
  const info = (chunk.manifest as Manifest).objects?.[role];
  if (!info || !captureStoreConfigured()) return null;
  const key = objectKey(projectPrefix(chunk.accountId, chunk.projectId), chunk.deviceId, info.key);
  if (!key) return null;
  const signed = await captureStore.presignDownload(key, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString(), encrypted: isEncrypted(chunk.manifest as Manifest) };
}

export async function assetUrl(accountId: string, projectId: string, deviceId: string, name: string) {
  const signed = await captureStore.presignDownload(`${projectPrefix(accountId, projectId)}/${deviceId}/assets/${name}`, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
}

// ─── Ranges ──────────────────────────────────────────────────────────────────

export function rangeView(range: Range) {
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

export async function rangesFor(projectId: string, userId: string, span: Span) {
  const rows = await db
    .select()
    .from(timelineRanges)
    .where(and(eq(timelineRanges.projectId, projectId), eq(timelineRanges.userId, userId), gte(timelineRanges.endAt, span.from), lte(timelineRanges.startAt, span.to)))
    .orderBy(asc(timelineRanges.startAt))
    .limit(1000);
  return rows.map(rangeView);
}

export async function saveRange(input: {
  accountId: string;
  projectId: string;
  userId: string;
  deviceId: string | null;
  title: string | null;
  startAt: Date;
  endAt: Date;
}): Promise<Range> {
  const [range] = await db
    .insert(timelineRanges)
    .values({ ...input, source: 'saved', status: 'closed', createdBy: input.userId })
    .returning();
  return range!;
}

export async function rangeInProject(projectId: string, rangeId: string): Promise<Range | null> {
  const [range] = await db
    .select()
    .from(timelineRanges)
    .where(and(eq(timelineRanges.rangeId, rangeId), eq(timelineRanges.projectId, projectId)))
    .limit(1);
  return range ?? null;
}

export async function rangeOutputsOf(rangeId: string) {
  const outputs = await db.select().from(rangeOutputs).where(eq(rangeOutputs.rangeId, rangeId)).orderBy(asc(rangeOutputs.createdAt));
  return outputs.map((o) => ({ kind: o.kind, status: o.status, model: o.model, output: o.output, usage: o.usage, error: o.error, updated_at: o.updatedAt.toISOString() }));
}

export async function closeRangeForReprocess(rangeId: string): Promise<void> {
  await db.update(timelineRanges).set({ status: 'closed', updatedAt: sql`now()` }).where(eq(timelineRanges.rangeId, rangeId));
}

// ─── People ──────────────────────────────────────────────────────────────────

/** Per member: a frame's time runs until the next frame of its device, capped at 60 s (a pause is not work). */
export async function peopleSummary(projectId: string, span: Span) {
  const perApp = Array.from(
    await db.execute<{ user_id: string; app: string | null; seconds: number }>(sql`
      SELECT user_id, app, round(sum(LEAST(EXTRACT(EPOCH FROM (next_ts - ts)), 60)))::int AS seconds
        FROM (SELECT user_id, app, ts, inactive, lead(ts) OVER (PARTITION BY device_id ORDER BY ts) AS next_ts
                FROM kortix.timeline_frames
               WHERE project_id = ${projectId}::uuid AND ts >= ${at(span.from)} AND ts < ${at(span.to)}) f
       WHERE NOT inactive AND next_ts IS NOT NULL
       GROUP BY user_id, app`),
  );
  const ranges = Array.from(
    await db.execute<{ user_id: string; ranges: number }>(sql`
      SELECT user_id, count(*)::int AS ranges FROM kortix.timeline_ranges
       WHERE project_id = ${projectId}::uuid AND end_at >= ${at(span.from)} AND start_at < ${at(span.to)}
       GROUP BY user_id`),
  );
  const devices = await db
    .select({ userId: captureDevices.userId, count: sql<number>`count(*)::int` })
    .from(captureDevices)
    .where(and(eq(captureDevices.projectId, projectId), isNull(captureDevices.revokedAt)))
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
  return [...people.values()].sort((a, b) => b.active_seconds - a.active_seconds);
}
