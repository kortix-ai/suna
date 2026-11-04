import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, artifactDocState, artifactDocUpdates, artifacts, drives, projects } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { db } from '../shared/db';
import { localTestDatabaseUrl } from '../__tests__/helpers/integration-fixtures';
import { interleave } from '../__tests__/helpers/interleave';
import { DOC_COMPACT_ROWS, DOC_MAX_BYTES_TOTAL, DOC_PAGE_MAX_BYTES } from './doc-rules';
import {
  ArtifactDocError,
  appendArtifactDocUpdate,
  compactArtifactDoc,
  leaseArtifactDoc,
  markArtifactDocFlushed,
  readArtifactDoc,
  resetArtifactDoc,
  seedArtifactDoc,
} from './doc-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
const otherUserId = crypto.randomUUID();
let projectId = '';
let driveId = '';

async function newDoc(): Promise<string> {
  const [row] = await db.insert(artifacts).values({
    accountId, projectId, driveId, root: `/Company/Artifacts/${crypto.randomUUID()}`, entry: 'index.md', folder: true,
    type: 'doc', title: 'Doc sync', visibility: 'project', createdByUserId: userId,
  }).returning({ artifactId: artifacts.artifactId });
  return row!.artifactId;
}

/** What a client sees: the `default` XML (tiptap's fragment) and the state vector. */
function state(doc: Y.Doc) {
  return { xml: doc.getXmlFragment('default').toString(), vector: [...Y.encodeStateVector(doc)] };
}

function addParagraph(doc: Y.Doc, text: string): void {
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment('default').insert(doc.getXmlFragment('default').length, [paragraph]);
}

async function rejects(run: Promise<unknown>, status: 400 | 404 | 409 | 413, code: string): Promise<void> {
  const error = await run.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ArtifactDocError);
  expect({ status: (error as ArtifactDocError).status, code: (error as ArtifactDocError).code }).toEqual({ status, code });
}

beforeAll(async () => {
  localTestDatabaseUrl();
  await db.insert(accounts).values({ accountId, name: 'Doc sync test' });
  const [project] = await db.insert(projects).values({ accountId, name: 'Doc sync', repoUrl: 'https://example.test/doc-sync.git' }).returning();
  projectId = project!.projectId;
  const [drive] = await db.insert(drives).values({ accountId, projectId, kind: 'project', name: 'Doc sync fixture', platinumVolumeName: `test-doc-sync-${crypto.randomUUID()}` }).returning();
  driveId = drive!.driveId;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('seed and append', () => {
  test('a doc without a state reads as not seeded; appending or leasing it → 409 doc_not_seeded', async () => {
    const artifactId = await newDoc();
    expect(await readArtifactDoc(artifactId, { after: 0, base: true }))
      .toEqual({ seeded: false, epoch: null, latestSeq: 0, updates: [], hasMore: false, flushed: null, lease: null });
    await rejects(appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId }), 409, 'doc_not_seeded');
    await rejects(leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false }), 409, 'doc_not_seeded');
  });

  test('the seed is seq 1 of a new epoch and already in the file; a second seed → 409 doc_seeded', async () => {
    const artifactId = await newDoc();
    const seeded = await seedArtifactDoc(artifactId, { update: Buffer.from([1, 2, 3]), markdown: '# Plan\n', version: 'v1', userId });
    expect(seeded.seq).toBe(1);
    expect(seeded.epoch).toMatch(UUID);
    await rejects(seedArtifactDoc(artifactId, { update: Buffer.from([9]), markdown: 'other', version: 'v2', userId: otherUserId }), 409, 'doc_seeded');
    const read = await readArtifactDoc(artifactId, { after: 0, base: true });
    expect(read).toMatchObject({ seeded: true, epoch: seeded.epoch, latestSeq: 1, hasMore: false, flushed: { seq: 1, version: 'v1', markdown: '# Plan\n' }, lease: null });
    expect(read.updates.map((u) => [u.seq, [...u.bytes]])).toEqual([[1, [1, 2, 3]]]);
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).flushed).toEqual({ seq: 1, version: 'v1' });
  });

  test('40 concurrent appends get 40 distinct, gap-free seqs, and every one is read back in order', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0]), markdown: '', version: 'v1', userId });
    const seqs = await Promise.all(Array.from({ length: 40 }, (_, i) => appendArtifactDocUpdate(artifactId, { update: Buffer.from([i]), userId })));
    expect(seqs.map((s) => s.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 2));
    const all = await readArtifactDoc(artifactId, { after: 0, base: false });
    expect(all.latestSeq).toBe(41);
    expect(all.updates.map((u) => u.seq)).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
    const tail = await readArtifactDoc(artifactId, { after: 30, base: false });
    expect(tail.updates.map((u) => u.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 31));
    const [owner] = await db.select({ createdBy: artifactDocUpdates.createdBy }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId)).limit(1);
    expect(owner!.createdBy).toBe(userId);
  });

  test('a page stops at the byte budget and says has_more; the next page continues after its last seq', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0]), markdown: '', version: 'v1', userId });
    const third = Math.floor(DOC_PAGE_MAX_BYTES / 3) + 1;
    for (let i = 0; i < 3; i++) await appendArtifactDocUpdate(artifactId, { update: Buffer.alloc(third, i + 1), userId });
    const first = await readArtifactDoc(artifactId, { after: 0, base: false });
    expect({ seqs: first.updates.map((u) => u.seq), hasMore: first.hasMore }).toEqual({ seqs: [1, 2, 3], hasMore: true });
    const second = await readArtifactDoc(artifactId, { after: 3, base: false });
    expect({ seqs: second.updates.map((u) => u.seq), hasMore: second.hasMore, size: second.updates[0]!.bytes.length }).toEqual({ seqs: [4], hasMore: false, size: third });
  });

  test('deleting the Artifact deletes its doc state and updates', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0]), markdown: '', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([1]), userId });
    await db.delete(artifacts).where(eq(artifacts.artifactId, artifactId));
    const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    expect(Number(left!.n)).toBe(0);
    expect(await db.select().from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId))).toEqual([]);
  });
});

describe('compaction', () => {
  test(`past ${DOC_COMPACT_ROWS} rows the oldest rows merge into the highest seq: same state, bytes_total follows`, async () => {
    const artifactId = await newDoc();
    const source = new Y.Doc();
    const pushed: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => pushed.push(u));
    addParagraph(source, 'Launch plan');
    await seedArtifactDoc(artifactId, { update: Buffer.from(pushed.shift()!), markdown: 'Launch plan\n', version: 'v1', userId });
    let rows = 1;
    // One edit per push: a new paragraph, and every third push a delete of the oldest one.
    for (let i = 0; rows <= DOC_COMPACT_ROWS; i++) {
      if (i % 3 === 2) source.getXmlFragment('default').delete(0, 1);
      else addParagraph(source, `Paragraph ${i}: ${'the quarter closed above plan '.repeat(3)}`);
      expect(pushed.length).toBe(1);
      rows = (await appendArtifactDocUpdate(artifactId, { update: Buffer.from(pushed.shift()!), userId })).rows;
    }
    expect(rows).toBe(DOC_COMPACT_ROWS + 1);
    const before = await readArtifactDoc(artifactId, { after: 0, base: false });
    const latest = before.latestSeq;
    // A client that pulled up to seq 200 before the compaction.
    const client = new Y.Doc();
    for (const u of before.updates.filter((u) => u.seq <= 200)) Y.applyUpdate(client, u.bytes);

    const results = await Promise.all([compactArtifactDoc(artifactId), compactArtifactDoc(artifactId)]);
    expect(results.filter((r) => r.done)).toEqual([{ done: true, fromSeq: 1, toSeq: latest, rows: DOC_COMPACT_ROWS + 1 }]);
    // The second run did not wait for the first: busy, or nothing left to merge.
    expect(results.filter((r) => !r.done).map((r) => (r.done ? '' : r.reason))).toEqual([expect.stringMatching(/^(busy|below_threshold)$/)]);

    const after = await readArtifactDoc(artifactId, { after: 0, base: false });
    expect(after.latestSeq).toBe(latest);
    expect(after.updates.map((u) => u.seq)).toEqual([latest]);
    const [total] = await db.select({ bytesTotal: artifactDocState.bytesTotal }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    expect(total!.bytesTotal).toBe(after.updates[0]!.bytes.length);
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, after.updates[0]!.bytes);
    expect(state(fresh)).toEqual(state(source));
    expect(state(fresh).xml).not.toContain('Launch plan');
    // The client asks for seq > 200 and gets the compacted row: nothing lost, nothing doubled.
    for (const u of (await readArtifactDoc(artifactId, { after: 200, base: false })).updates) Y.applyUpdate(client, u.bytes);
    expect(state(client)).toEqual(state(source));

    // New pushes continue above the compacted row.
    addParagraph(source, 'next');
    const next = await appendArtifactDocUpdate(artifactId, { update: Buffer.from(pushed.shift()!), userId });
    expect(next).toEqual({ seq: latest + 1, rows: 2 });
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: false, reason: 'below_threshold' });
    const caughtUp = new Y.Doc();
    for (const u of (await readArtifactDoc(artifactId, { after: 0, base: false })).updates) Y.applyUpdate(caughtUp, u.bytes);
    expect(state(caughtUp)).toEqual(state(source));
  }, 60_000);
});

describe('lease and flush', () => {
  test('acquire, contest, renew, flush by the holder only, and release', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([1]), userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([2]), userId });

    const a = await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    expect(a.kind).toBe('acquire');
    expect(a.leader).toBe(true);
    expect(a.holder).toBe('tab-a');
    const ttl = a.expiresAt!.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(10_000);
    expect(ttl).toBeLessThanOrEqual(16_000);

    const b = await leaseArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId, release: false });
    expect(b).toEqual({ kind: 'contested', leader: false, holder: 'tab-a', expiresAt: a.expiresAt });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).lease).toEqual({ holder: 'tab-a', expiresAt: a.expiresAt! });

    const renewed = await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    expect(renewed.kind).toBe('renew');
    expect(renewed.leader).toBe(true);
    expect(renewed.expiresAt!.getTime()).toBeGreaterThanOrEqual(a.expiresAt!.getTime());

    await rejects(markArtifactDocFlushed(artifactId, { holder: 'tab-b', userId: otherUserId, seq: 3, version: 'v2', markdown: 'two' }), 409, 'not_leader');
    await rejects(markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 4, version: 'v2', markdown: 'two' }), 400, 'invalid_seq');
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', markdown: 'two' })).toMatchObject({ flushedSeq: 3 });
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 2, version: 'v-old', markdown: 'old' })).toMatchObject({ flushedSeq: 3 });
    expect((await readArtifactDoc(artifactId, { after: 3, base: true })).flushed).toEqual({ seq: 3, version: 'v2', markdown: 'two' });

    expect(await leaseArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId, release: true })).toEqual({ kind: 'contested', leader: false, holder: 'tab-a', expiresAt: renewed.expiresAt });
    expect(await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: true })).toEqual({ kind: 'release', leader: false, holder: null, expiresAt: null });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).lease).toBeNull();
    expect((await leaseArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId, release: false })).leader).toBe(true);
  });

  test('an expired lease is taken over by another tab, which then owns the flush', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0]), markdown: 'one', version: 'v1', userId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    await db.update(artifactDocState).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(artifactDocState.artifactId, artifactId));
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).lease).toBeNull();
    // Nobody took it yet: the old holder may still record its flush.
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 1, version: 'v1b', markdown: 'one' })).toMatchObject({ flushedSeq: 1 });
    expect((await leaseArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId, release: false })).leader).toBe(true);
    await rejects(markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 1, version: 'v1c', markdown: 'one' }), 409, 'not_leader');
  });
});

describe('size', () => {
  test(`bytes_total counts the stored bytes; a push past ${DOC_MAX_BYTES_TOTAL / 1048576} MiB → 413 doc_too_large and stores nothing`, async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([1, 2, 3]), markdown: '', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.alloc(10, 7), userId });
    const total = async () => (await db.select({ b: artifactDocState.bytesTotal }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)))[0]!.b;
    expect(await total()).toBe(13);
    // Fill to 4 bytes under the cap without writing 16 MiB.
    await db.update(artifactDocState).set({ bytesTotal: DOC_MAX_BYTES_TOTAL - 4 }).where(eq(artifactDocState.artifactId, artifactId));
    await rejects(appendArtifactDocUpdate(artifactId, { update: Buffer.alloc(5, 1), userId }), 413, 'doc_too_large');
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).latestSeq).toBe(2);
    expect((await appendArtifactDocUpdate(artifactId, { update: Buffer.alloc(4, 1), userId })).seq).toBe(3);
    expect(await total()).toBe(DOC_MAX_BYTES_TOTAL);
  });
});

describe('compaction failure', () => {
  test('a compaction that throws records compaction_failed_at and none runs again for 10 min; the rows stay', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    // Rows written past the push checks: 500 empty updates and one that is not Yjs.
    await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, bytes)
      select ${artifactId}::uuid, g, case when g = 300 then decode('ffffffff', 'hex') else decode('0000', 'hex') end from generate_series(2, ${DOC_COMPACT_ROWS + 1}) g`);
    await db.update(artifactDocState).set({ nextSeq: DOC_COMPACT_ROWS + 2 }).where(eq(artifactDocState.artifactId, artifactId));
    const failedAt = async () => (await db.select({ at: artifactDocState.compactionFailedAt }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)))[0]!.at;

    expect(await compactArtifactDoc(artifactId)).toEqual({ done: false, reason: 'failed' });
    const first = await failedAt();
    expect(first).toBeInstanceOf(Date);
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).updates).toHaveLength(DOC_COMPACT_ROWS + 1);

    // Fixed, but inside the back-off: skipped without a read, and the stamp stays.
    await db.execute(sql`update kortix.artifact_doc_updates set bytes = decode('0000', 'hex') where artifact_id = ${artifactId}::uuid and seq = 300`);
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: false, reason: 'backoff' });
    expect((await failedAt())!.getTime()).toBe(first!.getTime());

    await db.update(artifactDocState).set({ compactionFailedAt: sql`now() - interval '11 minutes'` }).where(eq(artifactDocState.artifactId, artifactId));
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: true, fromSeq: 1, toSeq: DOC_COMPACT_ROWS + 1, rows: DOC_COMPACT_ROWS + 1 });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).updates.map((u) => u.seq)).toEqual([DOC_COMPACT_ROWS + 1]);
  }, 30_000);
});

describe('reset', () => {
  test('the lease holder resets: state and rows go, GET reads not seeded, and the next seed has a new epoch', async () => {
    const artifactId = await newDoc();
    const { epoch } = await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    await rejects(resetArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId }), 409, 'not_leader');
    await rejects(resetArtifactDoc(artifactId, { holder: 'tab-a', userId: otherUserId }), 409, 'not_leader');
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).latestSeq).toBe(2);

    expect(await resetArtifactDoc(artifactId, { holder: 'tab-a', userId })).toEqual({ reset: true });
    expect(await readArtifactDoc(artifactId, { after: 0, base: true })).toEqual({ seeded: false, epoch: null, latestSeq: 0, updates: [], hasMore: false, flushed: null, lease: null });
    const [left] = await db.select({ n: sql<number>`count(*)::int` }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    expect(Number(left!.n)).toBe(0);
    // Nothing left to reset: still 200.
    expect(await resetArtifactDoc(artifactId, { holder: 'tab-z', userId: otherUserId })).toEqual({ reset: true });

    const again = await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v2', userId: otherUserId });
    expect(again).toEqual({ seq: 1, epoch: expect.stringMatching(UUID) });
    expect(again.epoch).not.toBe(epoch);
  });

  test('anyone may reset while the lease is free or expired', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    await db.update(artifactDocState).set({ leaseExpiresAt: sql`now() - interval '1 second'` }).where(eq(artifactDocState.artifactId, artifactId));
    expect(await resetArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId })).toEqual({ reset: true });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).seeded).toBe(false);
  });
});

describe('an Artifact deleted while a write waits (FOR KEY SHARE)', () => {
  const deleteArtifact = (artifactId: string) => (tx: { query: (q: string, v: unknown[]) => Promise<unknown> }) =>
    tx.query('DELETE FROM kortix.artifacts WHERE artifact_id = $1', [artifactId]);

  test('seed, append, lease, flushed and reset each answer 404 not_found, never a foreign-key error', async () => {
    const writes: Array<[string, boolean, (id: string) => Promise<unknown>]> = [
      ['seed', false, (id) => seedArtifactDoc(id, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId })],
      ['append', true, (id) => appendArtifactDocUpdate(id, { update: Buffer.from([0, 0]), userId })],
      ['lease', true, (id) => leaseArtifactDoc(id, { holder: 'tab-a', userId, release: false })],
      ['flushed', true, (id) => markArtifactDocFlushed(id, { holder: 'tab-a', userId, seq: 1, version: 'v2', markdown: '' })],
      ['reset', true, (id) => resetArtifactDoc(id, { holder: 'tab-a', userId })],
    ];
    for (const [name, seeded, write] of writes) {
      const artifactId = await newDoc();
      if (seeded) {
        await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
        await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
      }
      const outcome = await interleave(deleteArtifact(artifactId), () => write(artifactId).then(() => 'ok', (e: unknown) => e), 'key share');
      expect({ name, status: (outcome as ArtifactDocError).status, code: (outcome as ArtifactDocError).code }).toEqual({ name, status: 404, code: 'not_found' });
    }
  }, 60_000);
});

describe('epoch on every write', () => {
  test('a push, lease or flush naming another epoch → 409 epoch_mismatch with the current epoch, and stores nothing; the current epoch or none passes', async () => {
    const artifactId = await newDoc();
    const stale = crypto.randomUUID();
    // Not seeded stays doc_not_seeded, whatever epoch the client names.
    await rejects(appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, epoch: stale }), 409, 'doc_not_seeded');
    await rejects(leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false, epoch: stale }), 409, 'doc_not_seeded');

    const { epoch } = await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    const mismatch = async (run: Promise<unknown>) => {
      const error = await run.then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(ArtifactDocError);
      expect({ status: (error as ArtifactDocError).status, code: (error as ArtifactDocError).code, detail: (error as ArtifactDocError).detail })
        .toEqual({ status: 409, code: 'epoch_mismatch', detail: { epoch } });
    };
    await mismatch(appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, epoch: stale }));
    await mismatch(leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false, epoch: stale }));
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).latestSeq).toBe(1);
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).lease).toBeNull();

    expect((await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, epoch })).seq).toBe(2);
    expect((await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId })).seq).toBe(3);
    expect((await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false, epoch })).leader).toBe(true);
    await mismatch(markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', markdown: 'two', epoch: stale }));
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', markdown: 'two', epoch })).toMatchObject({ flushedSeq: 3 });
  });
});

describe('compaction scans its input', () => {
  test('a stored row the push checks would refuse (a ContentBinary item, which Y.mergeUpdates merges) is never merged: failed, back-off, rows kept', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    // One ContentBinary item at the root of `d`: valid Yjs, content the editor never emits.
    const binary = Buffer.from([1, 1, 77, 0, 3, 1, 1, 0x64, 3, 1, 2, 3, 0]);
    expect(Y.decodeUpdate(new Uint8Array(binary)).structs).toHaveLength(1);
    await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, bytes)
      select ${artifactId}::uuid, g, case when g = 250 then ${binary}::bytea else decode('0000', 'hex') end from generate_series(2, ${DOC_COMPACT_ROWS + 1}) g`);
    await db.update(artifactDocState).set({ nextSeq: DOC_COMPACT_ROWS + 2 }).where(eq(artifactDocState.artifactId, artifactId));
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: false, reason: 'failed' });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).updates).toHaveLength(DOC_COMPACT_ROWS + 1);
    const [state] = await db.select({ at: artifactDocState.compactionFailedAt }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    expect(state!.at).toBeInstanceOf(Date);
  }, 30_000);
});

describe('who wrote (pending contributors)', () => {
  test('two writers push, the leader flushes: the flush names both writers and the seq range, then clears the list', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });

    const first = await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 4, version: 'v2', markdown: 'two' });
    expect({ ...first, contributors: [...first.contributors].sort() }).toEqual({ flushedSeq: 4, contributors: [userId, otherUserId].sort(), fromSeq: 2, toSeq: 4 });
    // Nothing pushed since: the next flush names nobody.
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 4, version: 'v3', markdown: 'two' }))
      .toEqual({ flushedSeq: 4, contributors: [], fromSeq: 5, toSeq: 4 });
    // An older seq sets nothing and names nobody.
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v0', markdown: 'old' })).contributors).toEqual([]);
  });

  test('a flush that does not reach the newest push keeps the pending writers for the next flush (a writer is never dropped)', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 2, version: 'v2', markdown: 'two' })).contributors).toEqual([otherUserId]);
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v3', markdown: 'three' })).contributors).toEqual([otherUserId]);
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v4', markdown: 'three' })).contributors).toEqual([]);
  });

  test('a merged (compacted) row names no single author', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, bytes, created_by)
      select ${artifactId}::uuid, g, decode('0000', 'hex'), ${otherUserId}::uuid from generate_series(2, ${DOC_COMPACT_ROWS + 1}) g`);
    await db.update(artifactDocState).set({ nextSeq: DOC_COMPACT_ROWS + 2 }).where(eq(artifactDocState.artifactId, artifactId));
    expect((await compactArtifactDoc(artifactId)).done).toBe(true);
    const rows = await db.select({ createdBy: artifactDocUpdates.createdBy }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    expect(rows).toEqual([{ createdBy: null }]);
  }, 30_000);
});
