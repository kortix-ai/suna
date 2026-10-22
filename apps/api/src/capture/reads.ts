/**
 * Kortix Capture timeline reads and writes behind account-routes.ts: devices,
 * the timeline, items, search, media. Every query is bound to (account, who):
 * a person, or one device that is linked to no person yet (an IT rollout
 * records a computer before anyone links it). The route decides who may ask.
 */
import { captureDevices, projectSessions, timelineChunks } from '@kortix/db';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type * as C from '@kortix/api-contract';
import { db } from '../shared/db';
import { config } from '../config';
import { classifyDevice, summarizeHealth } from './health';
import { accountPrefix, isEncrypted, liveState, objectKey, parseDisplay, type CaptureDisplay, type Manifest } from './format';
import { captureStoreForAccount } from './account-store';

export type Device = typeof captureDevices.$inferSelect;
export type Chunk = typeof timelineChunks.$inferSelect;
export interface Span {
  from: Date;
  to: Date;
}

/**
 * Whose rows a read returns: a person's (their user id), or one device's that
 * is linked to no person. Linking the device moves its rows to the person
 * (`reattributeDevice`), so a row has exactly one owner at a time.
 */
export type Who = string | { unlinkedDevice: string };

/** `who` as a raw SQL condition over a timeline table. The unlinked form uses the (account, user, ts) index with `user_id IS NULL`. */
const whoSql = (who: Who) =>
  typeof who === 'string' ? sql`user_id = ${who}::uuid` : sql`user_id IS NULL AND device_id = ${who.unlinkedDevice}::uuid`;

/** `who` over `timeline_chunks`, for Drizzle queries. */
const whoChunk = (who: Who): SQL =>
  typeof who === 'string'
    ? eq(timelineChunks.userId, who)
    : and(isNull(timelineChunks.userId), eq(timelineChunks.deviceId, who.unlinkedDevice))!;

/** The person a `Who` names, or null for an unlinked device. */
export const whoUserId = (who: Who | null): string | null => (typeof who === 'string' ? who : null);

/** A timestamptz parameter. A bare Date in raw SQL is sent as its local `toString()`. */
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const onDevice = (deviceId: string | undefined) => (deviceId ? sql` AND device_id = ${deviceId}::uuid` : sql``);
/**
 * Frames of one display, or (no display asked) the frames of the display that
 * held the focused window: one frame per moment, the one the person looked at.
 */
const onDisplay = (displayId: number | undefined) =>
  displayId === undefined ? sql` AND focused` : sql` AND display_id = ${displayId}`;

/** Raw SQL rows carry Postgres timestamp text; the API answers ISO 8601 like every other route. */
export function isoRows<T extends Record<string, unknown>>(rows: Iterable<T>): T[] {
  return Array.from(rows, (row) => {
    const out: Record<string, unknown> = { ...row };
    for (const key of ['ts', 'end_at', 'start_at']) {
      if (out[key] != null) out[key] = new Date(out[key] as string).toISOString();
    }
    // Postgres bigint arrives as text; a display id is a small integer.
    if (out.display_id != null) out.display_id = Number(out.display_id);
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

/** How long a computer must be silent before it counts as not recording (also the alert threshold). */
export const notRecordingAfterMs = () => config.KORTIX_CAPTURE_ALERT_AFTER_MINUTES * 60_000;

export function deviceHealth(device: Device, now: number, latestVersion: string | null) {
  return classifyDevice(
    { status: device.status, reportedAt: device.statusReportedAt, appVersion: device.appVersion },
    { now, latestVersion, notRecordingAfterMs: notRecordingAfterMs() },
  );
}

/** The devices answer: each device with its health, and the summary over the devices not revoked. */
export function devicesView(devices: Device[], latestVersion: string | null, now = Date.now()) {
  const views = devices.map((d) => deviceView(d, now, latestVersion));
  return { devices: views, health: summarizeHealth(views.filter((v) => !v.revoked_at).map((v) => v.health), latestVersion) };
}

export function deviceView(device: Device, now = Date.now(), latestVersion: string | null = null) {
  return {
    device_id: device.deviceId,
    user_id: device.userId,
    name: device.name,
    os: device.os,
    os_version: device.osVersion,
    arch: device.arch,
    app_version: device.appVersion,
    /** The displays the device reported in device.json, in its layout. */
    displays: deviceDisplays(device),
    live: { state: liveState(device.status, now), status: device.status, reported_at: device.statusReportedAt?.toISOString() ?? null },
    last_credentials_at: device.lastCredentialsAt?.toISOString() ?? null,
    revoked_at: device.revokedAt?.toISOString() ?? null,
    health: deviceHealth(device, now, latestVersion),
    /** The enrollment token the device enrolled with (an IT rollout); null when a person signed it in. */
    enrollment_token_id: device.enrollmentTokenId,
    created_at: device.createdAt.toISOString(),
  };
}

export function deviceDisplays(device: Device): CaptureDisplay[] {
  const listed = (device.deviceInfo as { displays?: unknown } | null)?.displays;
  return Array.isArray(listed) ? listed.map(parseDisplay).filter((d) => d !== null) : [];
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

// ─── Linking a device to a person ────────────────────────────────────────────

export type LinkOutcome = { kind: 'linked'; device: Device } | { kind: 'conflict'; deviceId: string };

/**
 * Link a device to a member (`userId`), or unlink it (null). From then on its
 * recordings belong to that person. Recordings it made while unlinked move to
 * the person in the background (`reattributeDevice`); recordings it made for
 * an earlier person stay theirs. A conflict: the person already has another
 * device row for the same computer (they signed it in themselves).
 */
export async function linkDevice(device: Device, userId: string | null): Promise<LinkOutcome> {
  if (userId) {
    const [other] = await db
      .select({ deviceId: captureDevices.deviceId })
      .from(captureDevices)
      .where(
        and(
          eq(captureDevices.accountId, device.accountId),
          eq(captureDevices.machineKeySha256, device.machineKeySha256),
          eq(captureDevices.userId, userId),
          sql`${captureDevices.deviceId} <> ${device.deviceId}::uuid`,
        ),
      )
      .limit(1);
    if (other) return { kind: 'conflict', deviceId: other.deviceId };
  }
  const [linked] = await db
    .update(captureDevices)
    .set({ userId, updatedAt: sql`now()` })
    .where(eq(captureDevices.deviceId, device.deviceId))
    .returning();
  return { kind: 'linked', device: linked! };
}

/** The timeline tables and their primary keys (a partitioned table's key includes `ts`). */
const OWNED_TABLES = [
  { table: 'timeline_chunks', key: 'chunk_id' },
  { table: 'timeline_frames', key: 'frame_id, ts' },
  { table: 'timeline_actions', key: 'action_id, ts' },
  { table: 'timeline_audio', key: 'line_id, ts' },
] as const;

/**
 * Move up to `batches` × `batchSize` rows per table that a device recorded
 * while unlinked to `userId`. Returns true when none is left. Idempotent: it
 * only touches rows with no person.
 */
export async function reattributeDevice(accountId: string, deviceId: string, userId: string, batches = 20, batchSize = 5000): Promise<boolean> {
  for (const { table, key } of OWNED_TABLES) {
    const t = sql.raw(`kortix.${table}`);
    const k = sql.raw(key);
    for (let i = 0; ; i++) {
      if (i === batches) return false;
      const moved = await db.execute(sql`
        UPDATE ${t} SET user_id = ${userId}::uuid
         WHERE (${k}) IN (SELECT ${k} FROM ${t}
                           WHERE account_id = ${accountId}::uuid AND user_id IS NULL AND device_id = ${deviceId}::uuid
                           LIMIT ${batchSize})`);
      if (((moved as { count?: number }).count ?? 0) < batchSize) break;
    }
  }
  return true;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

/**
 * Consecutive frames of one device with the same app and window title, no gap
 * over 2 minutes: of one display, or of the focused display at each moment.
 * Inactive frames (no input for `inactivity_seconds`, 5 s by default) count:
 * reading or watching is on screen, and the run names what was there.
 */
export async function timelineRuns(accountId: string, who: Who, span: Span, deviceId?: string, displayId?: number) {
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
                       WHERE account_id = ${accountId}::uuid AND ${whoSql(who)}
                         AND ts >= ${at(span.from)} AND ts < ${at(span.to)} ${onDevice(deviceId)} ${onDisplay(displayId)}
                      WINDOW w AS (PARTITION BY device_id ORDER BY ts)) marked) grouped
       GROUP BY device_id, grp, app, title
       ORDER BY min(ts)
       LIMIT 5000`),
  );
}

/**
 * Which display held the focused window, over time: consecutive focused frames
 * of one device on the same display, no gap over 2 minutes. The client resolves
 * the active display at any moment from these spans. Empty for one-display devices.
 */
export async function timelineFocus(accountId: string, who: Who, span: Span, deviceId?: string) {
  return isoRows(
    await db.execute<Record<string, unknown>>(sql`
      SELECT device_id, display_id, min(ts) AS start_at, max(ts) AS end_at
        FROM (SELECT *, sum(brk) OVER (PARTITION BY device_id ORDER BY ts) AS grp
                FROM (SELECT device_id, ts, display_id,
                             CASE WHEN display_id IS NOT DISTINCT FROM lag(display_id) OVER w
                                   AND ts - lag(ts) OVER w < interval '2 minutes'
                                  THEN 0 ELSE 1 END AS brk
                        FROM kortix.timeline_frames
                       WHERE account_id = ${accountId}::uuid AND ${whoSql(who)} AND focused AND display_id IS NOT NULL
                         AND ts >= ${at(span.from)} AND ts < ${at(span.to)} ${onDevice(deviceId)}
                      WINDOW w AS (PARTITION BY device_id ORDER BY ts)) marked) grouped
       GROUP BY device_id, grp, display_id
       ORDER BY min(ts)
       LIMIT 5000`),
  );
}

export async function timelineChunksIn(accountId: string, who: Who, span: Span, deviceId?: string, displayId?: number) {
  return db
    .select({
      chunk_id: timelineChunks.chunkId,
      device_id: timelineChunks.deviceId,
      kind: timelineChunks.kind,
      start_at: timelineChunks.startAt,
      end_at: timelineChunks.endAt,
      item_count: timelineChunks.itemCount,
      encrypted: timelineChunks.encrypted,
      display_id: timelineChunks.displayId,
      display: timelineChunks.display,
    })
    .from(timelineChunks)
    .where(
      and(
        eq(timelineChunks.accountId, accountId),
        whoChunk(who),
        gte(timelineChunks.endAt, span.from),
        lte(timelineChunks.startAt, span.to),
        ...(deviceId ? [eq(timelineChunks.deviceId, deviceId)] : []),
        // Audio and action items belong to no display; a display filter keeps them.
        ...(displayId !== undefined
          ? [sql`(${timelineChunks.kind} <> 'chunk' OR ${timelineChunks.displayId} = ${displayId})`]
          : []),
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
export async function recordedDays(accountId: string, who: Who, opts: { tz: string; deviceId?: string }) {
  const rows = await db.execute<{ day: string; start_at: string; end_at: string; screen_seconds: number }>(sql`
    SELECT to_char((start_at AT TIME ZONE ${opts.tz})::date, 'YYYY-MM-DD') AS day,
           min(start_at) AS start_at, max(end_at) AS end_at,
           coalesce(round(sum(EXTRACT(EPOCH FROM (end_at - start_at))) FILTER (WHERE kind = 'chunk')), 0)::int AS screen_seconds
      FROM kortix.timeline_chunks
     WHERE account_id = ${accountId}::uuid AND ${whoSql(who)} ${onDevice(opts.deviceId)}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 366`);
  return isoRows(rows).map((row) => ({ ...row, screen_seconds: Number(row.screen_seconds) }));
}

/** The displays of the screen items in a window, one per display id, with their latest layout. */
export function displaysOf(chunks: Array<{ kind: string; display_id: number | null; display: unknown }>): CaptureDisplay[] {
  const byId = new Map<number, CaptureDisplay>();
  for (const chunk of chunks) {
    const display = chunk.kind === 'chunk' ? parseDisplay(chunk.display) : null;
    if (display) byId.set(display.id, display);
  }
  return [...byId.values()].sort((a, b) => Number(b.main) - Number(a.main) || a.x - b.x || a.y - b.y);
}

/**
 * Frames, actions and audio in a window. Frames: every display's (`displayId`
 * absent and `allDisplays`), one display's, or by default the focused display's.
 */
export async function timelineItems(
  accountId: string,
  who: Who,
  span: Span,
  deviceId?: string,
  opts: { displayId?: number; allDisplays?: boolean } = {},
) {
  const where = sql`account_id = ${accountId}::uuid AND ${whoSql(who)} AND ts >= ${at(span.from)} AND ts < ${at(span.to)} ${onDevice(deviceId)}`;
  const frameWhere = opts.allDisplays && opts.displayId === undefined ? where : sql`${where} ${onDisplay(opts.displayId)}`;
  const [frames, actions, audio] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`SELECT frame_id, ts, device_id, chunk_id, frame_index, app, bundle_id, title, url, domain, ocr_text, inactive, display_id, focused FROM kortix.timeline_frames WHERE ${frameWhere} ORDER BY ts LIMIT ${opts.allDisplays && opts.displayId === undefined ? 2000 : 500}`),
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
  /** null = the whole account (people with capture.read_all). */
  who: Who | null,
  opts: { q: string; from: Date; to: Date; kinds: Set<SearchKind>; app?: string; deviceId?: string; limit: number },
) {
  const scope = sql`account_id = ${accountId}::uuid ${who ? sql`AND ${whoSql(who)}` : sql``} AND ts >= ${at(opts.from)} AND ts < ${at(opts.to)} ${onDevice(opts.deviceId)} ${opts.app ? sql` AND lower(app) = lower(${opts.app})` : sql``}`;
  const query = sql`websearch_to_tsquery('simple', ${opts.q})`;
  const parts = [
    opts.kinds.has('screen') &&
      sql`(SELECT * FROM (SELECT DISTINCT ON (chunk_id, title) 'screen' AS kind, frame_id AS id, ts, user_id, device_id, chunk_id, app, title, url, display_id, ocr_text AS text FROM kortix.timeline_frames WHERE ${scope} AND ${FRAME_DOC} @@ ${query} ORDER BY chunk_id, title, ts DESC) per_window ORDER BY ts DESC LIMIT ${opts.limit})`,
    opts.kinds.has('actions') &&
      sql`(SELECT 'actions' AS kind, action_id AS id, ts, user_id, device_id, chunk_id, app, window_title AS title, NULL AS url, NULL::bigint AS display_id, description AS text FROM kortix.timeline_actions WHERE ${scope} AND ${ACTION_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${opts.limit})`,
    opts.kinds.has('audio') &&
      sql`(SELECT 'audio' AS kind, line_id AS id, ts, user_id, device_id, chunk_id, NULL AS app, NULL AS title, NULL AS url, NULL::bigint AS display_id, text FROM kortix.timeline_audio WHERE ${scope} AND ${AUDIO_DOC} @@ ${query} ORDER BY ts DESC LIMIT ${opts.limit})`,
  ].filter(Boolean) as ReturnType<typeof sql>[];
  if (parts.length === 0) return [];
  const rows = isoRows(
    await db.execute<Record<string, unknown>>(sql`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) hits ORDER BY ts DESC LIMIT ${opts.limit}`),
  );
  // Each UNION arm selects the hit's columns in this order (kind, id, ts, user_id, device_id, chunk_id, app, title, url, display_id).
  const names = await displayNames(rows.filter((row) => row.display_id != null).map((row) => String(row.chunk_id)));
  return rows.map(({ text, ...row }) => ({
    ...(row as Omit<C.CaptureSearchHit, 'snippet' | 'display_id' | 'display_name'>),
    display_id: row.display_id == null ? null : Number(row.display_id),
    display_name: names.get(String(row.chunk_id)) ?? null,
    snippet: snippet(text as string | null, opts.q),
  }));
}

/** The display name of each screen item, by chunk id. */
async function displayNames(chunkIds: string[]): Promise<Map<string, string>> {
  if (chunkIds.length === 0) return new Map();
  const rows = await db
    .select({ chunkId: timelineChunks.chunkId, display: timelineChunks.display })
    .from(timelineChunks)
    .where(inArray(timelineChunks.chunkId, [...new Set(chunkIds)]));
  return new Map(rows.flatMap((row) => {
    const name = parseDisplay(row.display)?.name;
    return name ? [[row.chunkId, name] as const] : [];
  }));
}

// ─── Media ───────────────────────────────────────────────────────────────────

const MEDIA_TTL_SECONDS = 300;

export async function frameOf(accountId: string, who: Who, frameId: string) {
  const [frame] = isoRows(
    await db.execute<Record<string, unknown>>(
      sql`SELECT * FROM kortix.timeline_frames WHERE frame_id = ${frameId}::uuid AND account_id = ${accountId}::uuid AND ${whoSql(who)} LIMIT 1`,
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

export async function chunkOf(accountId: string, who: Who, chunkId: string): Promise<Chunk | null> {
  const [chunk] = await db
    .select()
    .from(timelineChunks)
    .where(and(eq(timelineChunks.chunkId, chunkId), eq(timelineChunks.accountId, accountId), whoChunk(who)))
    .limit(1);
  return chunk ?? null;
}

/** A 5-minute signed GET of one object of an indexed item, or null. */
export async function mediaUrl(chunk: Chunk, role: string) {
  const info = (chunk.manifest as Manifest).objects?.[role];
  if (!info) return null;
  const store = await captureStoreForAccount(chunk.accountId);
  if (!store.configured) return null;
  const key = objectKey(accountPrefix(chunk.accountId), chunk.deviceId, info.key);
  if (!key) return null;
  const signed = await store.presignDownload(key, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString(), encrypted: isEncrypted(chunk.manifest as Manifest) };
}

/** The action screenshot nearest a moment on one device (within `withinMs`), as a still of what was on screen. */
export async function nearestScreenshot(accountId: string, who: Who, deviceId: string, ts: Date, withinMs = 30_000): Promise<{ name: string; ts: string } | null> {
  const [row] = isoRows(
    await db.execute<Record<string, unknown>>(sql`
      SELECT screenshot AS name, ts FROM kortix.timeline_actions
       WHERE account_id = ${accountId}::uuid AND ${whoSql(who)} AND device_id = ${deviceId}::uuid AND screenshot IS NOT NULL
         AND ts BETWEEN ${new Date(ts.getTime() - withinMs).toISOString()}::timestamptz AND ${new Date(ts.getTime() + withinMs).toISOString()}::timestamptz
       ORDER BY abs(extract(epoch FROM ts - ${ts.toISOString()}::timestamptz)) LIMIT 1`),
  );
  return row ? { name: String(row.name), ts: String(row.ts) } : null;
}

export async function assetUrl(accountId: string, deviceId: string, name: string) {
  const store = await captureStoreForAccount(accountId);
  const signed = await store.presignDownload(`${accountPrefix(accountId)}/${deviceId}/assets/${name}`, MEDIA_TTL_SECONDS);
  return { url: signed.url, expires_at: signed.expiresAt.toISOString() };
}
