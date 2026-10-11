/**
 * Kortix Capture timeline reads and writes behind account-routes.ts: devices,
 * the timeline, items, search, media. Every query
 * is bound to (account, person); the route decides who may ask.
 */
import { captureDevices, projectSessions, timelineChunks } from '@kortix/db';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import type * as C from '@kortix/api-contract';
import { db } from '../shared/db';
import { accountPrefix, isEncrypted, liveState, objectKey, type Manifest } from './format';
import { captureStore, captureStoreConfigured } from './store';

export type Device = typeof captureDevices.$inferSelect;
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

/**
 * The one place Capture reads a project table: the agent tool's edge. An agent
 * session (in some project) reads the Capture data of the person it acts for,
 * and only in a private session. Returns the session's visibility, or null.
 */
export async function sessionVisibility(sessionId: string): Promise<string | null> {
  const [session] = await db
    .select({ visibility: projectSessions.visibility })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
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
    last_credentials_at: device.lastCredentialsAt?.toISOString() ?? null,
    revoked_at: device.revokedAt?.toISOString() ?? null,
    created_at: device.createdAt.toISOString(),
  };
}

export async function listDevices(accountId: string, userId: string | null): Promise<Device[]> {
  return db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.accountId, accountId), ...(userId ? [eq(captureDevices.userId, userId)] : [])))
    .orderBy(desc(captureDevices.updatedAt));
}

export async function deviceInAccount(accountId: string, deviceId: string): Promise<Device | null> {
  const [device] = await db
    .select()
    .from(captureDevices)
    .where(and(eq(captureDevices.deviceId, deviceId), eq(captureDevices.accountId, accountId)))
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
export async function timelineRuns(accountId: string, userId: string, span: Span, deviceId?: string) {
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
                       WHERE account_id = ${accountId}::uuid AND user_id = ${userId}::uuid
                         AND ts >= ${at(span.from)} AND ts < ${at(span.to)} AND NOT inactive ${onDevice(deviceId)}
                      WINDOW w AS (PARTITION BY device_id ORDER BY ts)) marked) grouped
       GROUP BY device_id, grp, app, title
       ORDER BY min(ts)
       LIMIT 5000`),
  );
}

export async function timelineChunksIn(accountId: string, userId: string, span: Span, deviceId?: string) {
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
        eq(timelineChunks.accountId, accountId),
        eq(timelineChunks.userId, userId),
        gte(timelineChunks.endAt, span.from),
        lte(timelineChunks.startAt, span.to),
        ...(deviceId ? [eq(timelineChunks.deviceId, deviceId)] : []),
      ),
    )
    .orderBy(asc(timelineChunks.startAt))
    .limit(5000);
}

/**
 * The days with recorded items, newest first (at most 366): each local day in
 * `tz` with its first and last recorded moment and its seconds of screen chunks.
 * Grouped over items (5-minute chunks), not frames, so a year costs ~100k rows at most.
 */
export async function recordedDays(accountId: string, userId: string, opts: { tz: string; deviceId?: string }) {
  const rows = await db.execute<{ day: string; start_at: string; end_at: string; screen_seconds: number }>(sql`
    SELECT to_char((start_at AT TIME ZONE ${opts.tz})::date, 'YYYY-MM-DD') AS day,
           min(start_at) AS start_at, max(end_at) AS end_at,
           coalesce(round(sum(EXTRACT(EPOCH FROM (end_at - start_at))) FILTER (WHERE kind = 'chunk')), 0)::int AS screen_seconds
      FROM kortix.timeline_chunks
     WHERE account_id = ${accountId}::uuid AND user_id = ${userId}::uuid ${onDevice(opts.deviceId)}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 366`);
  return isoRows(rows).map((row) => ({ ...row, screen_seconds: Number(row.screen_seconds) }));
}

export async function timelineItems(accountId: string, userId: string, span: Span, deviceId?: string) {
  const where = sql`account_id = ${accountId}::uuid AND user_id = ${userId}::uuid AND ts >= ${at(span.from)} AND ts < ${at(span.to)} ${onDevice(deviceId)}`;
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
  accountId: string,
  /** null = every member of the account (Capture admins and viewers, Ask). */
  userId: string | null,
  opts: { q: string; from: Date; to: Date; kinds: Set<SearchKind>; app?: string; deviceId?: string; limit: number },
) {
  const scope = sql`account_id = ${accountId}::uuid ${userId ? sql`AND user_id = ${userId}::uuid` : sql``} AND ts >= ${at(opts.from)} AND ts < ${at(opts.to)} ${onDevice(opts.deviceId)} ${opts.app ? sql` AND lower(app) = lower(${opts.app})` : sql``}`;
  const query = sql`websearch_to_tsquery('simple', ${opts.q})`;
  const parts = [
    opts.kinds.has('screen') &&
      sql`(SELECT * FROM (SELECT DISTINCT ON (chunk_id, title) 'screen' AS kind, frame_id AS id, ts, user_id, device_id, chunk_id, app, title, url, ocr_text AS text FROM kortix.timeline_frames WHERE ${scope} AND ${FRAME_DOC} @@ ${query} ORDER BY chunk_id, title, ts DESC) per_window ORDER BY ts DESC LIMIT ${opts.limit})`,
    opts.kinds.has('actions') &&
      sql`(SELECT 'actions' AS kind, action_id AS id, ts, user_id, device_id, chunk_id, app, window_title AS title, NULL AS url, description AS text FROM kortix.timeline_actions WHERE ${scope} AND ${ACTION_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${opts.limit})`,
    opts.kinds.has('audio') &&
      sql`(SELECT 'audio' AS kind, line_id AS id, ts, user_id, device_id, chunk_id, NULL AS app, NULL AS title, NULL AS url, text FROM kortix.timeline_audio WHERE ${scope} AND ${AUDIO_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${opts.limit})`,
  ].filter(Boolean) as ReturnType<typeof sql>[];
  if (parts.length === 0) return [];
  const rows = isoRows(
    await db.execute<Record<string, unknown>>(sql`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) hits ORDER BY ts DESC LIMIT ${opts.limit}`),
  );
  // Each UNION arm selects the hit's columns in this order (kind, id, ts, user_id, device_id, chunk_id, app, title, url).
  return rows.map(({ text, ...row }) => ({ ...(row as Omit<C.CaptureSearchHit, 'snippet'>), snippet: snippet(text as string | null, opts.q) }));
}

// ─── Media ───────────────────────────────────────────────────────────────────

const MEDIA_TTL_SECONDS = 300;

export async function frameOf(accountId: string, userId: string, frameId: string) {
  const [frame] = isoRows(
    await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM kortix.timeline_frames WHERE frame_id = ${frameId}::uuid AND account_id = ${accountId}::uuid AND user_id = ${userId}::uuid LIMIT 1`,
    ),
  );
  if (!frame) return null;
  const [chunk] = await db.select().from(timelineChunks).where(eq(timelineChunks.chunkId, frame.chunk_id as string)).limit(1);
  return { frame, chunk: chunk ?? null };
}

/**
 * Where a frame sits in its chunk video. The format records the video at 1 fps
 * with frame i at t = i s (capture-format.md, `chunk`), whatever the capture
 * interval was, so the offset is `frame_index` seconds, not the wall-clock gap.
 * A frame without an index sits at its position among the chunk's frames.
 */
export async function frameVideoOffsetMs(frame: Record<string, unknown>): Promise<number> {
  if (typeof frame.frame_index === 'number') return frame.frame_index * 1000;
  const [row] = Array.from(
    await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM kortix.timeline_frames WHERE chunk_id = ${frame.chunk_id as string}::uuid AND ts < ${frame.ts as string}::timestamptz`,
    ),
  );
  return (row?.n ?? 0) * 1000;
}

export async function chunkOf(accountId: string, userId: string, chunkId: string): Promise<Chunk | null> {
  const [chunk] = await db
    .select()
    .from(timelineChunks)
    .where(and(eq(timelineChunks.chunkId, chunkId), eq(timelineChunks.accountId, accountId), eq(timelineChunks.userId, userId)))
    .limit(1);
  return chunk ?? null;
}

/** A 5-minute signed GET of one object of an indexed item, or null. */
export async function mediaUrl(chunk: Chunk, role: string) {
  const info = (chunk.manifest as Manifest).objects?.[role];
  if (!info || !captureStoreConfigured()) return null;
  const key = objectKey(accountPrefix(chunk.accountId), chunk.deviceId, info.key);
  if (!key) return null;
  const signed = await captureStore.presignDownload(key, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString(), encrypted: isEncrypted(chunk.manifest as Manifest) };
}

/** The action screenshot nearest a moment on one device (within `withinMs`), as a still of what was on screen. */
export async function nearestScreenshot(accountId: string, userId: string, deviceId: string, ts: Date, withinMs = 30_000): Promise<{ name: string; ts: string } | null> {
  const [row] = isoRows(
    await db.execute<Record<string, unknown>>(sql`
      SELECT screenshot AS name, ts FROM kortix.timeline_actions
       WHERE account_id = ${accountId}::uuid AND user_id = ${userId}::uuid AND device_id = ${deviceId}::uuid AND screenshot IS NOT NULL
         AND ts BETWEEN ${new Date(ts.getTime() - withinMs).toISOString()}::timestamptz AND ${new Date(ts.getTime() + withinMs).toISOString()}::timestamptz
       ORDER BY abs(extract(epoch FROM ts - ${ts.toISOString()}::timestamptz)) LIMIT 1`),
  );
  return row ? { name: String(row.name), ts: String(row.ts) } : null;
}

export async function assetUrl(accountId: string, deviceId: string, name: string) {
  const signed = await captureStore.presignDownload(`${accountPrefix(accountId)}/${deviceId}/assets/${name}`, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
}
