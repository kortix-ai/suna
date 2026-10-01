/** Deleting chunks: S3 objects first, then rows (frames cascade). Used by the retention sweep and delete-own-data. */
import { captureChunks, captureDevices } from '@kortix/db';
import { eq, inArray, or } from 'drizzle-orm';
import { db } from '../shared/db';
import type { ObjectStore } from '../object-store/s3';
import { captureAccountPrefix, captureStore } from './store';

export async function deleteChunks(
  rows: Array<{ id: string; videoKey: string }>,
  store: ObjectStore = captureStore,
): Promise<number> {
  if (rows.length === 0) return 0;
  // A failed object delete throws before any row goes, so the next run retries it.
  await store.remove(rows.map((row) => row.videoKey));
  await db.delete(captureChunks).where(inArray(captureChunks.id, rows.map((row) => row.id)));
  return rows.length;
}

/**
 * Account or user deletion: erase every capture of `accountIds` and every
 * capture of `userId` (in any account). `capture_chunks.user_id` has no foreign
 * key, so deleting the auth user would leave rows and objects behind.
 * Objects go first. Each account's prefix is swept too, which also catches an
 * object whose chunk row is gone. Throws on a store failure so the caller retries.
 */
export async function purgeCapture(
  input: { accountIds: string[]; userId?: string },
  store: ObjectStore = captureStore,
): Promise<number> {
  const owned = [
    input.accountIds.length ? inArray(captureChunks.accountId, input.accountIds) : undefined,
    input.userId ? eq(captureChunks.userId, input.userId) : undefined,
  ].filter((w) => w !== undefined);
  if (owned.length === 0) return 0;
  const where = or(...owned);
  let deleted = 0;
  for (;;) {
    const rows = await db.select({ id: captureChunks.id, videoKey: captureChunks.videoKey }).from(captureChunks).where(where).limit(500);
    if (store.configured) deleted += await deleteChunks(rows, store);
    else if (rows.length) {
      await db.delete(captureChunks).where(inArray(captureChunks.id, rows.map((row) => row.id)));
      deleted += rows.length;
    }
    if (rows.length < 500) break;
  }
  if (store.configured) {
    for (const accountId of input.accountIds) {
      for (;;) {
        const objects = await store.list(captureAccountPrefix(accountId));
        if (objects.length === 0) break;
        await store.remove(objects.map((o) => o.key));
      }
    }
  }
  await db.delete(captureDevices).where(
    or(
      input.accountIds.length ? inArray(captureDevices.accountId, input.accountIds) : undefined,
      input.userId ? eq(captureDevices.userId, input.userId) : undefined,
    ),
  );
  return deleted;
}
