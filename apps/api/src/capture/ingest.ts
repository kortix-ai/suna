/**
 * One idempotent ingest per manifest key: the only path from the bucket into
 * the timeline tables. Both readers (SQS events, index polling) only enqueue
 * `capture.ingest` jobs keyed by the manifest key; the job runs this.
 *
 *   1. the key must be a Kortix key of a known device in a project with `capture` on
 *   2. read the manifest; reject a newer schema or another device's manifest
 *   3. read every object it lists; its size and SHA-256 must match (else retry)
 *   4. parse frames / actions / transcript lines, skipping layers the policy turned off
 *   5. insert the chunk row and its lines in one transaction; a second ingest of
 *      the same key finds the chunk row and does nothing
 *   6. extend the device's detected activity range
 */
import { createHash } from 'node:crypto';
import {
  captureDevices,
  projects,
  timelineActions,
  timelineAudio,
  timelineChunks,
  timelineFrames,
  timelineRanges,
} from '@kortix/db';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import {
  PolicySchema,
  checkManifest,
  isEncrypted,
  jsonLines,
  objectKey,
  parseActionLine,
  parseCaptureKey,
  parseFrameLine,
  projectPrefix,
  type Manifest,
} from './format';
import { readProjectPolicy } from './policy';
import { captureStore } from './store';

export type IngestOutcome =
  | { status: 'indexed'; chunkId: string; kind: Manifest['kind']; items: number }
  | { status: 'duplicate' | 'ignored' | 'skipped'; reason: string };

/** Detected ranges split where a device was silent this long. */
export const RANGE_GAP_MS = 15 * 60_000;
const INSERT_BATCH = 500;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function readObject(key: string, expected: { size: number; sha256: string }): Promise<Uint8Array> {
  const bytes = await captureStore.getBytes(key);
  if (!bytes) throw new Error(`object missing: ${key}`);
  if (bytes.byteLength !== expected.size) throw new Error(`size mismatch for ${key}: ${bytes.byteLength} != ${expected.size}`);
  if (sha256(bytes) !== expected.sha256) throw new Error(`sha256 mismatch for ${key}`);
  return bytes;
}

const zstdLines = (bytes: Uint8Array) => jsonLines(new TextDecoder().decode(Bun.zstdDecompressSync(bytes)));

async function insertBatched<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) await insert(rows.slice(i, i + INSERT_BATCH));
}

export async function ingestManifest(key: string): Promise<IngestOutcome> {
  const parsed = parseCaptureKey(key);
  if (!parsed || !key.endsWith('.manifest.json')) return { status: 'ignored', reason: 'not a Kortix capture manifest key' };
  const [device] = await db
    .select()
    .from(captureDevices)
    .where(
      and(
        eq(captureDevices.deviceId, parsed.deviceId),
        eq(captureDevices.projectId, parsed.projectId),
        eq(captureDevices.accountId, parsed.accountId),
      ),
    )
    .limit(1);
  if (!device) return { status: 'ignored', reason: 'unknown device' };
  const [project] = await db
    .select({ metadata: projects.metadata })
    .from(projects)
    .where(eq(projects.projectId, device.projectId))
    .limit(1);
  if (!project || !resolveFeatureFlag(project.metadata, 'capture')) return { status: 'skipped', reason: 'capture is off for the project' };
  const [existing] = await db
    .select({ chunkId: timelineChunks.chunkId })
    .from(timelineChunks)
    .where(eq(timelineChunks.manifestKey, key))
    .limit(1);
  if (existing) return { status: 'duplicate', reason: 'already indexed' };

  const manifestText = await captureStore.getText(key);
  if (manifestText === null) throw new Error(`manifest missing: ${key}`);
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    return { status: 'ignored', reason: 'manifest is not JSON (encrypted manifests are not readable by Kortix)' };
  }
  const checked = checkManifest(raw, device.deviceId);
  if (!checked.ok) return { status: 'ignored', reason: checked.reason };
  const manifest = checked.manifest;
  const prefix = projectPrefix(device.accountId, device.projectId);

  // Server-side enforcement of the layers: a device never widens the policy, and
  // neither does the index.
  const policy = device.policyOverride
    ? PolicySchema.parse(device.policyOverride)
    : (await readProjectPolicy(device.projectId)).policy;
  const layer = { chunk: 'screen', actions: 'actions', audio: 'audio' } as const;
  if (!policy.layers[layer[manifest.kind]]) return { status: 'skipped', reason: `${layer[manifest.kind]} layer is off by policy` };

  const objects: Record<string, Uint8Array> = {};
  for (const [role, info] of Object.entries(manifest.objects)) {
    const full = objectKey(prefix, device.deviceId, info.key);
    if (!full) return { status: 'ignored', reason: `object "${role}" is outside the device folder` };
    // The video and audio are verified, never parsed: read them to check the hash.
    objects[role] = await readObject(full, info);
  }

  const owner = { projectId: device.projectId, deviceId: device.deviceId, userId: device.userId };
  const encrypted = isEncrypted(manifest);
  const frames =
    manifest.kind === 'chunk' && !encrypted && objects.frames
      ? zstdLines(objects.frames).map(parseFrameLine).filter((row) => row !== null)
      : [];
  const actions =
    manifest.kind === 'actions' && !encrypted
      ? zstdLines(objects.actions!).map(parseActionLine).filter((row) => row !== null)
      : [];
  const audio =
    manifest.kind === 'audio' && !encrypted
      ? (manifest.transcript ?? []).filter((line) => line.text.trim())
      : [];
  const items = frames.length + actions.length + audio.length;

  const chunkId = await db.transaction(async (tx) => {
    const [chunk] = await tx
      .insert(timelineChunks)
      .values({
        accountId: device.accountId,
        ...owner,
        kind: manifest.kind,
        manifestKey: key,
        startAt: new Date(manifest.start_ms),
        endAt: new Date(manifest.end_ms),
        itemCount: items,
        encrypted,
        manifest: manifest as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: timelineChunks.manifestKey })
      .returning({ chunkId: timelineChunks.chunkId });
    if (!chunk) return null;
    await insertBatched(frames, (batch) =>
      tx.insert(timelineFrames).values(batch.map((f) => ({ ...f, ...owner, chunkId: chunk.chunkId }))),
    );
    await insertBatched(actions, (batch) =>
      tx.insert(timelineActions).values(batch.map((a) => ({ ...a, ...owner, chunkId: chunk.chunkId }))),
    );
    await insertBatched(audio, (batch) =>
      tx.insert(timelineAudio).values(
        batch.map((line) => ({
          ...owner,
          chunkId: chunk.chunkId,
          ts: new Date(line.start_ms),
          endAt: new Date(Math.max(line.end_ms, line.start_ms)),
          text: line.text,
        })),
      ),
    );
    return chunk.chunkId;
  });
  if (!chunkId) return { status: 'duplicate', reason: 'indexed concurrently' };
  await extendDetectedRange(device, new Date(manifest.start_ms), new Date(manifest.end_ms));
  logger.info('[capture] indexed', { kind: manifest.kind, items, deviceId: device.deviceId });
  return { status: 'indexed', chunkId, kind: manifest.kind, items };
}

/**
 * Grow the device's detected range that this activity touches (within the gap),
 * merging ranges it bridges; else start a new one. A range that grows after it
 * was closed or processed reopens, so its outputs are recomputed.
 */
export async function extendDetectedRange(
  device: { accountId: string; projectId: string; userId: string; deviceId: string },
  startAt: Date,
  endAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`capture-range:${device.deviceId}`}, 0))`);
    const touching = await tx
      .select()
      .from(timelineRanges)
      .where(
        and(
          eq(timelineRanges.deviceId, device.deviceId),
          eq(timelineRanges.source, 'detected'),
          lte(timelineRanges.startAt, new Date(endAt.getTime() + RANGE_GAP_MS)),
          gte(timelineRanges.endAt, new Date(startAt.getTime() - RANGE_GAP_MS)),
        ),
      )
      .orderBy(timelineRanges.startAt);
    if (touching.length === 0) {
      await tx.insert(timelineRanges).values({
        accountId: device.accountId,
        projectId: device.projectId,
        userId: device.userId,
        deviceId: device.deviceId,
        source: 'detected',
        startAt,
        endAt,
      });
      return;
    }
    const [keep, ...merged] = touching;
    const start = new Date(Math.min(startAt.getTime(), ...touching.map((r) => r.startAt.getTime())));
    const end = new Date(Math.max(endAt.getTime(), ...touching.map((r) => r.endAt.getTime())));
    const grew = merged.length > 0 || start < keep!.startAt || end > keep!.endAt;
    if (!grew) return;
    for (const range of merged) await tx.delete(timelineRanges).where(eq(timelineRanges.rangeId, range.rangeId));
    await tx
      .update(timelineRanges)
      .set({ startAt: start, endAt: end, status: 'open', updatedAt: sql`now()` })
      .where(eq(timelineRanges.rangeId, keep!.rangeId));
  });
}
