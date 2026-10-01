/**
 * Kortix Capture machine API: the recorder on a paired machine calls these with
 * its own credential (`Authorization: Bearer kortix_tnl_…` + `X-Tunnel-Id`,
 * `authenticateMachine`). Mounted before user auth, under `/v1/capture/agent`.
 *
 *   GET  /config                    whether capture may run now (creates the device row)
 *   POST /chunks                    register one mp4, get a presigned PUT
 *   POST /chunks/:chunkId/commit    check the object, store the frames
 *
 * The owner is `tunnel_connections.owner_user_id`; a machine without one cannot capture.
 */
import { accounts, captureAccountSettings, captureChunks, captureDevices, captureFrames } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { accountRoleFor } from '../iam/read-models';
import { requestClientKey } from '../shared/client-ip';
import { db } from '../shared/db';
import { isUuid } from '../shared/validate';
import { tunnelRateLimiter } from '../tunnel/core/rate-limiter';
import { authenticateMachine } from '../tunnel/routes/connections';
import type { AppEnv } from '../types';
import { MAX_VIDEO_BYTES, UPLOAD_URL_TTL_SECONDS, captureStore, captureVideoKey } from './store';

export const POLL_SECONDS = 60;
const MAX_FRAMES_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_TEXT_CHARS = 32 * 1024;
const FRAME_INSERT_BATCH = 500;

type Machine = { tunnelId: string; accountId: string; ownerUserId: string | null };

const fail = (c: any, status: 400 | 403 | 404 | 409 | 429 | 503, code: string, error: string) =>
  c.json({ error, code }, status);

const noAccount = (c: any) =>
  fail(c, 409, 'CAPTURE_NO_ACCOUNT', "The machine's account does not exist yet. Its owner must sign in to Kortix once.");

/** Rate limit, verify the credential, and resolve the owner. Returns a Response to send, or the machine. */
async function machineFor(c: any, bucket: 'captureConfig' | 'captureChunk' | 'captureCommit') {
  const limited = tunnelRateLimiter.check(bucket, `${requestClientKey(c)}:${c.req.header('x-tunnel-id') ?? ''}`);
  if (!limited.allowed) return { response: c.json({ error: 'Too many requests', retryAfterMs: limited.retryAfterMs }, 429) };
  const verified = await authenticateMachine(c);
  if (!verified.ok) return { response: verified.response };
  const machine: Machine = verified.machine;
  if (!machine.ownerUserId) return { response: fail(c, 409, 'CAPTURE_NO_OWNER', 'This machine has no owner. Pair it again.') };
  return { machine: { ...machine, ownerUserId: machine.ownerUserId } };
}

/**
 * The device row of a machine, created off on first sight in the machine's
 * account. Null when that account has no row yet (its owner never signed in).
 */
async function deviceFor(machine: Machine & { ownerUserId: string }) {
  const touch = () =>
    db.update(captureDevices).set({ lastSeenAt: new Date() }).where(eq(captureDevices.tunnelId, machine.tunnelId)).returning();
  const [existing] = await touch();
  if (existing) return existing;
  const [account] = await db.select({ id: accounts.accountId }).from(accounts).where(eq(accounts.accountId, machine.accountId));
  if (!account) return null;
  await db
    .insert(captureDevices)
    .values({ accountId: machine.accountId, userId: machine.ownerUserId, tunnelId: machine.tunnelId })
    .onConflictDoNothing({ target: captureDevices.tunnelId });
  return (await touch())[0]!;
}

/**
 * What the recorder may do right now. Settings come from the DEVICE's account:
 * a private machine is paired into its owner's personal account, and the owner
 * moves the device to a team account with `PUT /capture/devices/:id`. The owner
 * must still be a member of that account.
 */
async function allowance(machine: Machine & { ownerUserId: string }) {
  const device = await deviceFor(machine);
  if (!device) return null;
  const [settings] = await db
    .select()
    .from(captureAccountSettings)
    .where(eq(captureAccountSettings.accountId, device.accountId));
  const member = (await accountRoleFor(device.accountId, machine.ownerUserId)) !== null;
  const paused = device.pausedUntil !== null && device.pausedUntil.getTime() > Date.now();
  const accountEnabled = settings?.enabled ?? false;
  return {
    device,
    retentionDays: settings?.retentionDays ?? 30,
    accountEnabled,
    allowed: member && accountEnabled && device.enabled && !paused,
  };
}

const isoDate = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const intIn = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 ? v.replaceAll('\u0000', '').slice(0, max) : null;

export function createCaptureAgentRouter() {
  const router = new Hono<AppEnv>();

  router.get('/config', async (c) => {
    const m = await machineFor(c, 'captureConfig');
    if (!m.machine) return m.response;
    const a = await allowance(m.machine);
    if (!a) return noAccount(c);
    return c.json({
      capture_allowed: a.allowed,
      account_enabled: a.accountEnabled,
      device_enabled: a.device.enabled,
      paused_until: a.device.pausedUntil?.toISOString() ?? null,
      retention_days: a.retentionDays,
      poll_seconds: POLL_SECONDS,
    });
  });

  router.post('/chunks', bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Body too large' }, 413) }), async (c) => {
    const m = await machineFor(c, 'captureChunk');
    if (!m.machine) return m.response;
    if (!captureStore.configured) return fail(c, 503, 'CAPTURE_STORAGE_UNCONFIGURED', 'Capture storage is not configured');
    const a = await allowance(m.machine);
    if (!a) return noAccount(c);
    if (!a.allowed) return fail(c, 403, 'CAPTURE_DISABLED', 'Capture is not enabled for this machine');

    const body = await c.req.json().catch(() => null);
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const clientUid = str(b.client_uid, 128);
    const startedAt = isoDate(b.started_at);
    const endedAt = isoDate(b.ended_at);
    const frameCount = intIn(b.frame_count, 0, 1_000_000);
    const width = intIn(b.width, 1, 32_768);
    const height = intIn(b.height, 1, 32_768);
    const videoBytes = intIn(b.video_bytes, 1, MAX_VIDEO_BYTES);
    const sha = typeof b.video_sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.video_sha256) ? b.video_sha256 : null;
    const codec = b.codec === 'hevc' || b.codec === 'h264' ? b.codec : null;
    if (!clientUid || !startedAt || !endedAt || endedAt < startedAt || frameCount === null || !width || !height || !videoBytes || !sha || !codec) {
      return fail(c, 400, 'CAPTURE_BAD_CHUNK', 'Invalid chunk: need client_uid, started_at <= ended_at, frame_count, width, height, codec (hevc|h264), video_bytes (1..200 MB), video_sha256 (hex)');
    }

    const device = a.device;
    const chunkId = crypto.randomUUID();
    await db
      .insert(captureChunks)
      .values({
        id: chunkId,
        accountId: device.accountId,
        userId: m.machine.ownerUserId,
        deviceId: device.id,
        clientUid,
        startedAt,
        endedAt,
        frameCount,
        width,
        height,
        codec,
        videoKey: captureVideoKey({ accountId: device.accountId, userId: m.machine.ownerUserId, startedAt, chunkId }),
        videoBytes,
        videoSha256: sha,
      })
      .onConflictDoNothing({ target: [captureChunks.deviceId, captureChunks.clientUid] });
    const [chunk] = await db
      .select()
      .from(captureChunks)
      .where(and(eq(captureChunks.deviceId, device.id), eq(captureChunks.clientUid, clientUid)));
    if (chunk!.status === 'committed') return c.json({ chunk_id: chunk!.id, already_committed: true });
    // A retry of a pending chunk gets a fresh URL for the size it declares now.
    if (chunk!.videoBytes !== videoBytes) {
      await db.update(captureChunks).set({ videoBytes, videoSha256: sha }).where(eq(captureChunks.id, chunk!.id));
    }
    const upload = await captureStore.presignUpload(chunk!.videoKey, UPLOAD_URL_TTL_SECONDS, 'video/mp4', videoBytes);
    return c.json({
      chunk_id: chunk!.id,
      upload: { method: 'PUT', url: upload.url, headers: upload.headers },
      already_committed: false,
    });
  });

  router.post(
    '/chunks/:chunkId/commit',
    bodyLimit({ maxSize: MAX_FRAMES_BODY_BYTES, onError: (c) => c.json({ error: 'Body too large' }, 413) }),
    async (c) => {
      const m = await machineFor(c, 'captureCommit');
      if (!m.machine) return m.response;
      const chunkId = c.req.param('chunkId');
      if (!isUuid(chunkId)) return fail(c, 400, 'CAPTURE_BAD_CHUNK', 'chunk id must be a UUID');
      const [row] = await db
        .select({ chunk: captureChunks })
        .from(captureChunks)
        .innerJoin(captureDevices, eq(captureDevices.id, captureChunks.deviceId))
        .where(and(eq(captureChunks.id, chunkId), eq(captureDevices.tunnelId, m.machine.tunnelId)));
      if (!row) return fail(c, 404, 'CAPTURE_CHUNK_NOT_FOUND', 'Chunk not found');
      const chunk = row.chunk;
      const stored = async () =>
        Number(
          (await db.select({ n: sql<number>`count(*)` }).from(captureFrames).where(eq(captureFrames.chunkId, chunk.id)))[0]!.n,
        );
      if (chunk.status === 'committed') return c.json({ ok: true, frames: await stored() });

      const body = await c.req.json().catch(() => null);
      const rawFrames = body && typeof body === 'object' && Array.isArray((body as any).frames) ? ((body as any).frames as unknown[]) : null;
      if (!rawFrames) return fail(c, 400, 'CAPTURE_BAD_FRAMES', 'Body must be {"frames":[…]}');
      const frames: Array<typeof captureFrames.$inferInsert> = [];
      for (const raw of rawFrames) {
        const f = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        const frameIndex = intIn(f.frame_index, 0, 2_147_483_647);
        const ts = isoDate(f.ts);
        if (frameIndex === null || !ts) return fail(c, 400, 'CAPTURE_BAD_FRAMES', 'Each frame needs an integer frame_index and an ISO ts');
        frames.push({
          chunkId: chunk.id,
          accountId: chunk.accountId,
          userId: chunk.userId,
          ts,
          frameIndex,
          appBundle: str(f.app_bundle, 255),
          appName: str(f.app_name, 255),
          windowTitle: str(f.window_title, 2048),
          url: str(f.url, 4096),
          domain: str(f.domain, 255),
          text: str(f.text, MAX_FRAME_TEXT_CHARS),
        });
      }

      const head = await captureStore.head(chunk.videoKey);
      if (!head) return fail(c, 409, 'CAPTURE_UPLOAD_MISSING', 'The video was not uploaded');
      if (head.bytes !== chunk.videoBytes) {
        return fail(c, 409, 'CAPTURE_SIZE_MISMATCH', `Uploaded ${head.bytes} bytes, declared ${chunk.videoBytes}`);
      }

      await db.transaction(async (tx) => {
        const [marked] = await tx
          .update(captureChunks)
          .set({ status: 'committed', committedAt: new Date() })
          .where(and(eq(captureChunks.id, chunk.id), eq(captureChunks.status, 'pending')))
          .returning({ id: captureChunks.id });
        if (!marked) return; // a concurrent commit won; it stored the frames
        for (let i = 0; i < frames.length; i += FRAME_INSERT_BATCH) {
          await tx.insert(captureFrames).values(frames.slice(i, i + FRAME_INSERT_BATCH)).onConflictDoNothing();
        }
        await tx.update(captureDevices).set({ lastUploadAt: new Date() }).where(eq(captureDevices.id, chunk.deviceId));
      });
      return c.json({ ok: true, frames: await stored() });
    },
  );

  return router;
}
