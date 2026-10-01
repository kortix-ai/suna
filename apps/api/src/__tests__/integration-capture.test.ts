/**
 * Integration (real local Postgres, recording S3 client): Kortix Capture's
 * retention sweep and the chunk/frame schema it relies on. Synthetic data only.
 *
 * Run: pnpm test -- --db-only integration-capture
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import { captureAccountSettings, captureChunks, captureDevices, captureFrames } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { runCaptureRetentionOnce } from '../capture/sweeper';
import { ObjectStore } from '../object-store/s3';
import { db } from '../shared/db';
import { seedAccount } from './helpers/integration-fixtures';

const DAY = 86_400_000;
const accountIds: string[] = [];

function recordingStore(failOnce = false) {
  const deleted: string[] = [];
  let failed = !failOnce;
  const client = {
    send: async (command: unknown) => {
      if (!failed) {
        failed = true;
        throw new Error('storage unavailable');
      }
      if (command instanceof DeleteObjectsCommand) {
        for (const o of command.input.Delete?.Objects ?? []) deleted.push(o.Key!);
      }
      return { Deleted: [] };
    },
  } as unknown as S3Client;
  return { deleted, store: new ObjectStore(() => ({ name: 'capture-test', bucket: 'b' }), { client }) };
}

async function seedChunk(
  accountId: string,
  userId: string,
  deviceId: string,
  o: { ageDays: number; status?: 'pending' | 'committed' },
) {
  const id = crypto.randomUUID();
  const startedAt = new Date(Date.now() - o.ageDays * DAY);
  await db.insert(captureChunks).values({
    id,
    accountId,
    userId,
    deviceId,
    clientUid: id,
    startedAt,
    endedAt: new Date(startedAt.getTime() + 300_000),
    frameCount: 1,
    width: 10,
    height: 10,
    codec: 'h264',
    videoKey: `capture/${accountId}/${id}.mp4`,
    videoBytes: 1,
    videoSha256: 'a'.repeat(64),
    status: o.status ?? 'committed',
    createdAt: startedAt,
  });
  await db.insert(captureFrames).values({
    chunkId: id,
    accountId,
    userId,
    ts: startedAt,
    frameIndex: 0,
    windowTitle: 'Synthetic window',
    text: 'synthetic text',
  });
  return id;
}

const remaining = async (ids: string[]) =>
  new Set((await db.select({ id: captureChunks.id }).from(captureChunks).where(inArray(captureChunks.id, ids))).map((r) => r.id));

afterAll(async () => {
  for (const id of accountIds) await db.execute(sql`delete from kortix.accounts where account_id = ${id}`);
});

describe('capture retention sweep', () => {
  test('deletes objects then rows older than the account retention, keeps newer, default 30 days, drops abandoned pending uploads', async () => {
    const userId = crypto.randomUUID();
    const short = await seedAccount('capture-short');
    const dflt = await seedAccount('capture-default');
    accountIds.push(short, dflt);
    await db.insert(captureAccountSettings).values({ accountId: short, enabled: true, retentionDays: 7 });
    const [d1] = await db.insert(captureDevices).values({ accountId: short, userId }).returning();
    const [d2] = await db.insert(captureDevices).values({ accountId: dflt, userId }).returning();

    const oldShort = await seedChunk(short, userId, d1!.id, { ageDays: 8 });
    const freshShort = await seedChunk(short, userId, d1!.id, { ageDays: 6 });
    const midDefault = await seedChunk(dflt, userId, d2!.id, { ageDays: 20 });
    const oldDefault = await seedChunk(dflt, userId, d2!.id, { ageDays: 31 });
    const staleUpload = await seedChunk(dflt, userId, d2!.id, { ageDays: 2, status: 'pending' });
    const freshUpload = await seedChunk(dflt, userId, d2!.id, { ageDays: 0, status: 'pending' });
    const all = [oldShort, freshShort, midDefault, oldDefault, staleUpload, freshUpload];

    const { store, deleted } = recordingStore();
    const count = await runCaptureRetentionOnce(store);

    expect(count).toBeGreaterThanOrEqual(3);
    expect(await remaining(all)).toEqual(new Set([freshShort, midDefault, freshUpload]));
    expect(deleted.sort()).toEqual(
      [`capture/${short}/${oldShort}.mp4`, `capture/${dflt}/${oldDefault}.mp4`, `capture/${dflt}/${staleUpload}.mp4`].sort(),
    );
    const frames = await db.select({ chunkId: captureFrames.chunkId }).from(captureFrames).where(inArray(captureFrames.chunkId, all));
    expect(new Set(frames.map((f) => f.chunkId))).toEqual(new Set([freshShort, midDefault, freshUpload]));
  });

  test('a failed object delete keeps the rows for the next run', async () => {
    const userId = crypto.randomUUID();
    const accountId = await seedAccount('capture-retry');
    accountIds.push(accountId);
    const [device] = await db.insert(captureDevices).values({ accountId, userId }).returning();
    const old = await seedChunk(accountId, userId, device!.id, { ageDays: 40 });

    const failing = recordingStore(true);
    await expect(runCaptureRetentionOnce(failing.store)).rejects.toThrow('storage unavailable');
    expect((await remaining([old])).has(old)).toBe(true);

    const ok = recordingStore();
    await runCaptureRetentionOnce(ok.store);
    expect((await remaining([old])).has(old)).toBe(false);
    expect(ok.deleted).toContain(`capture/${accountId}/${old}.mp4`);
  });

  test('full-text search finds a frame by window title and OCR text through the generated tsv', async () => {
    const userId = crypto.randomUUID();
    const accountId = await seedAccount('capture-fts');
    accountIds.push(accountId);
    const [device] = await db.insert(captureDevices).values({ accountId, userId }).returning();
    const chunk = await seedChunk(accountId, userId, device!.id, { ageDays: 1 });
    await db.update(captureFrames).set({ text: 'rollout of the quokka service' }).where(eq(captureFrames.chunkId, chunk));
    const hit = await db
      .select({ id: captureFrames.id })
      .from(captureFrames)
      .where(sql`${captureFrames.accountId} = ${accountId} and ${captureFrames.tsv} @@ websearch_to_tsquery('simple', 'quokka')`);
    const miss = await db
      .select({ id: captureFrames.id })
      .from(captureFrames)
      .where(sql`${captureFrames.accountId} = ${accountId} and ${captureFrames.tsv} @@ websearch_to_tsquery('simple', 'synthetic window')`);
    expect(hit).toHaveLength(1);
    expect(miss).toHaveLength(1);
  });
});
