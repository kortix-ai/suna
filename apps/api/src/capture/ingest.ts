/**
 * One idempotent ingest per manifest key: the only path from the bucket into
 * the timeline tables. Both readers (SQS events, index polling) only enqueue
 * `capture.ingest` jobs keyed by the manifest key; the job runs this.
 *
 *   1. the key must be a Kortix key of a known device in an account with Capture on
 *   2. read the manifest; reject a newer schema or another device's manifest
 *   3. read every object it lists; its size and SHA-256 must match (else retry)
 *   4. parse frames / actions / transcript lines, skipping layers the policy turned off
 *   5. insert the chunk row and its lines in one transaction; a second ingest of
 *      the same key finds the chunk row and does nothing
 */
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import {
  captureDevices,
  timelineActions,
  timelineAudio,
  timelineChunks,
  timelineFrames,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { logger } from '../lib/logger';
import {
  checkManifest,
  isEncrypted,
  jsonLines,
  objectKey,
  parseActionLine,
  parseCaptureKey,
  parseDisplay,
  parseFrameLine,
  accountPrefix,
  type Manifest,
} from './format';
import { captureEnabled, readWorkspace } from './workspace';
import { captureStoreForAccount } from './account-store';
import type { ObjectStore } from '../object-store/s3';

export type IngestOutcome =
  | { status: 'indexed'; chunkId: string; kind: Manifest['kind']; items: number }
  | { status: 'duplicate' | 'ignored' | 'skipped'; reason: string };

const INSERT_BATCH = 500;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A device writes the objects, so their sizes are capped before anything is read. */
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_INDEX_LINES_BYTES = 64 * 1024 * 1024;

async function readObject(store: ObjectStore, key: string, expected: { size: number; sha256: string }): Promise<Uint8Array> {
  if (expected.size > MAX_OBJECT_BYTES) throw new Error(`object too large: ${key}: ${expected.size} bytes`);
  const bytes = await store.getBytes(key, { maxBytes: expected.size });
  if (!bytes) throw new Error(`object missing: ${key}`);
  if (bytes.byteLength !== expected.size) throw new Error(`size mismatch for ${key}: ${bytes.byteLength} != ${expected.size}`);
  if (sha256(bytes) !== expected.sha256) throw new Error(`sha256 mismatch for ${key}`);
  return bytes;
}

// Bun implements node:zlib zstd with `maxOutputLength`; this @types/node predates it.
const { zstdDecompressSync } = zlib as unknown as {
  zstdDecompressSync(bytes: Uint8Array, opts: { maxOutputLength: number }): Uint8Array;
};
// Bounded: a small zstd bomb cannot inflate past the cap.
const zstdLines = (bytes: Uint8Array) =>
  jsonLines(new TextDecoder().decode(zstdDecompressSync(bytes, { maxOutputLength: MAX_INDEX_LINES_BYTES })));

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
        eq(captureDevices.accountId, parsed.accountId),
      ),
    )
    .limit(1);
  if (!device) return { status: 'ignored', reason: 'unknown device' };
  if (!(await captureEnabled(device.accountId))) return { status: 'skipped', reason: 'capture is off for the account' };
  const [existing] = await db
    .select({ chunkId: timelineChunks.chunkId })
    .from(timelineChunks)
    .where(eq(timelineChunks.manifestKey, key))
    .limit(1);
  if (existing) return { status: 'duplicate', reason: 'already indexed' };

  const store = await captureStoreForAccount(device.accountId);
  const manifestBytes = await store.getBytes(key, { maxBytes: 1024 * 1024 });
  if (manifestBytes === null) throw new Error(`manifest missing: ${key}`);
  const manifestText = new TextDecoder().decode(manifestBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(manifestText);
  } catch {
    return { status: 'ignored', reason: 'manifest is not JSON (encrypted manifests are not readable by Kortix)' };
  }
  const checked = checkManifest(raw, device.deviceId);
  if (!checked.ok) return { status: 'ignored', reason: checked.reason };
  const manifest = checked.manifest;
  const prefix = accountPrefix(device.accountId);

  // Server-side enforcement of the layers: a device never widens the policy, and
  // neither does the index.
  const { policy } = await readWorkspace(device.accountId);
  const layer = { chunk: 'screen', actions: 'actions', audio: 'audio' } as const;
  if (!policy.layers[layer[manifest.kind]]) return { status: 'skipped', reason: `${layer[manifest.kind]} layer is off by policy` };

  const objects: Record<string, Uint8Array> = {};
  for (const [role, info] of Object.entries(manifest.objects)) {
    const full = objectKey(prefix, device.deviceId, info.key);
    if (!full) return { status: 'ignored', reason: `object "${role}" is outside the device folder` };
    // The video and audio are verified, never parsed: read them to check the hash.
    objects[role] = await readObject(store, full, info);
  }

  const owner = { accountId: device.accountId, deviceId: device.deviceId, userId: device.userId };
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
  // A multi-display device writes one screen item per display.
  const display = manifest.kind === 'chunk' ? parseDisplay(manifest.display) : null;

  const chunkId = await db.transaction(async (tx) => {
    const [chunk] = await tx
      .insert(timelineChunks)
      .values({
        ...owner,
        kind: manifest.kind,
        manifestKey: key,
        startAt: new Date(manifest.start_ms),
        endAt: new Date(manifest.end_ms),
        itemCount: items,
        encrypted,
        manifest: manifest as Record<string, unknown>,
        displayId: display?.id ?? null,
        display: display as Record<string, unknown> | null,
      })
      .onConflictDoNothing({ target: timelineChunks.manifestKey })
      .returning({ chunkId: timelineChunks.chunkId });
    if (!chunk) return null;
    await insertBatched(frames, (batch) =>
      tx.insert(timelineFrames).values(
        // The item's display is the frames' display when a line does not name one.
        batch.map((f) => ({ ...f, displayId: f.displayId ?? display?.id ?? null, ...owner, chunkId: chunk.chunkId })),
      ),
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
  logger.info('[capture] indexed', { kind: manifest.kind, items, deviceId: device.deviceId });
  return { status: 'indexed', chunkId, kind: manifest.kind, items };
}
