/** Deleting chunks: S3 objects first, then rows (frames cascade). Used by the retention sweep and delete-own-data. */
import { captureChunks } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { db } from '../shared/db';
import { captureStore } from './store';

export async function deleteChunks(rows: Array<{ id: string; videoKey: string }>): Promise<number> {
  if (rows.length === 0) return 0;
  // A failed object delete throws before any row goes, so the next run retries it.
  await captureStore.remove(rows.map((row) => row.videoKey));
  await db.delete(captureChunks).where(inArray(captureChunks.id, rows.map((row) => row.id)));
  return rows.length;
}
