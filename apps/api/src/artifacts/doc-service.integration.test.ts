import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, artifactDocState, artifactDocUpdates, artifacts, drives, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { db } from '../shared/db';
import { localTestDatabaseUrl } from '../__tests__/helpers/integration-fixtures';
import { interleave } from '../__tests__/helpers/interleave';
import { EDITOR_BLOCK_PUSHES, EDITOR_BLOCK_SEED } from './doc-editor-updates.fixture';
import { gcArtifactDocs } from './doc-gc';
import { DOC_COMPACT_ROWS, DOC_MAX_BYTES_TOTAL, DOC_PAGE_MAX_BYTES, DOC_PAGE_MAX_STRUCTS } from './doc-rules';
import { placeDocUpdate } from './doc-scan';
import {
  ArtifactDocError,
  appendArtifactDocUpdate,
  compactArtifactDoc,
  leaseArtifactDoc,
  markArtifactDocFlushed,
  readArtifactDoc,
  recordArtifactDocEdits,
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

    await rejects(markArtifactDocFlushed(artifactId, { holder: 'tab-b', userId: otherUserId, seq: 3, version: 'v2', currentVersion: 'v2', markdown: 'two' }), 409, 'not_leader');
    await rejects(markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 4, version: 'v2', currentVersion: 'v2', markdown: 'two' }), 400, 'invalid_seq');
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', currentVersion: 'v2', markdown: 'two' })).toMatchObject({ flushedSeq: 3 });
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 2, version: 'v-old', currentVersion: 'v-old', markdown: 'old' })).toMatchObject({ flushedSeq: 3 });
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
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 1, version: 'v1b', currentVersion: 'v1b', markdown: 'one' })).toMatchObject({ flushedSeq: 1 });
    expect((await leaseArtifactDoc(artifactId, { holder: 'tab-b', userId: otherUserId, release: false })).leader).toBe(true);
    await rejects(markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 1, version: 'v1c', currentVersion: 'v1c', markdown: 'one' }), 409, 'not_leader');
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
  /** 500 empty updates after the seed, with `bad` bytes at the given seqs (rows written past the push checks). */
  async function docWithRows(bad: Record<number, Buffer>): Promise<string> {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, epoch, bytes)
      select ${artifactId}::uuid, g, (select epoch from kortix.artifact_doc_state where artifact_id = ${artifactId}::uuid), decode('0000', 'hex') from generate_series(2, ${DOC_COMPACT_ROWS + 1}) g`);
    for (const [seq, bytes] of Object.entries(bad)) {
      await db.update(artifactDocUpdates).set({ bytes }).where(and(eq(artifactDocUpdates.artifactId, artifactId), eq(artifactDocUpdates.seq, Number(seq))));
    }
    await db.update(artifactDocState).set({
      nextSeq: DOC_COMPACT_ROWS + 2,
      bytesTotal: sql`(select sum(octet_length(bytes))::bigint from kortix.artifact_doc_updates where artifact_id = ${artifactId}::uuid)`,
    }).where(eq(artifactDocState.artifactId, artifactId));
    return artifactId;
  }
  const quarantined = async (artifactId: string) => (await db.select({ seq: artifactDocUpdates.seq }).from(artifactDocUpdates)
    .where(and(eq(artifactDocUpdates.artifactId, artifactId), sql`${artifactDocUpdates.quarantinedAt} is not null`))).map((r) => r.seq).sort((x, y) => x - y);

  test('rows no Yjs reader takes (the review’s 7-byte Skip/Item mismatch, bytes that are not Yjs, a ContentBinary item) are quarantined, and the rest compact: one bad row never stalls compaction', async () => {
    const skipMismatch = Buffer.from([0x01, 0x01, 0x01, 0x00, 0x4a, 0x01, 0x00]);
    const binary = Buffer.from([1, 1, 77, 0, 3, 1, 1, 0x64, 3, 1, 2, 3, 0]);
    expect(Y.decodeUpdate(new Uint8Array(binary)).structs).toHaveLength(1);
    const artifactId = await docWithRows({ 250: binary, 300: skipMismatch, 450: Buffer.from([0xff, 0xff, 0xff, 0xff]) });

    expect(await compactArtifactDoc(artifactId)).toEqual({ done: true, fromSeq: 1, toSeq: DOC_COMPACT_ROWS + 1, rows: DOC_COMPACT_ROWS - 2, quarantined: [250, 300, 450] });
    expect(await quarantined(artifactId)).toEqual([250, 300, 450]);
    // No back-off: the next push may compact again.
    const [state] = await db.select({ at: artifactDocState.compactionFailedAt, bytes: artifactDocState.bytesTotal }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    expect(state!.at).toBeNull();
    // A quarantined row stays where it was (it is still served; a client that cannot apply it resets the doc).
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).updates.map((u) => u.seq)).toEqual([250, 300, 450, DOC_COMPACT_ROWS + 1]);
    const [stored] = await db.select({ total: sql<number>`sum(octet_length(${artifactDocUpdates.bytes}))::int` }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    expect(state!.bytes).toBe(Number(stored!.total));
    // Quarantined rows do not count toward the next compaction.
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: false, reason: 'below_threshold' });
  }, 30_000);

  test('inside the 10-minute back-off nothing runs; after it, compaction runs', async () => {
    const artifactId = await docWithRows({});
    await db.update(artifactDocState).set({ compactionFailedAt: sql`now()` }).where(eq(artifactDocState.artifactId, artifactId));
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: false, reason: 'backoff' });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).updates).toHaveLength(DOC_COMPACT_ROWS + 1);
    await db.update(artifactDocState).set({ compactionFailedAt: sql`now() - interval '11 minutes'` }).where(eq(artifactDocState.artifactId, artifactId));
    expect(await compactArtifactDoc(artifactId)).toEqual({ done: true, fromSeq: 1, toSeq: DOC_COMPACT_ROWS + 1, rows: DOC_COMPACT_ROWS + 1 });
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

describe('a compaction step is scoped to the epoch it planned against', () => {
  /** 501 rows of 2 bytes in the current epoch, past the threshold. */
  async function bigDoc(): Promise<string> {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, epoch, bytes)
      select ${artifactId}::uuid, g, (select epoch from kortix.artifact_doc_state where artifact_id = ${artifactId}::uuid), decode('0000', 'hex') from generate_series(2, ${DOC_COMPACT_ROWS + 1}) g`);
    await db.update(artifactDocState).set({ nextSeq: DOC_COMPACT_ROWS + 2, bytesTotal: (DOC_COMPACT_ROWS + 1) * 2 }).where(eq(artifactDocState.artifactId, artifactId));
    return artifactId;
  }
  /** A reset and a re-seed in one open transaction: a new epoch whose rows start again at seq 1 (7 bytes). */
  const resetAndReseed = (artifactId: string) => async (tx: { query: (q: string, v: unknown[]) => Promise<unknown> }) => {
    await tx.query('DELETE FROM kortix.artifact_doc_updates WHERE artifact_id = $1', [artifactId]);
    await tx.query('DELETE FROM kortix.artifact_doc_state WHERE artifact_id = $1', [artifactId]);
    await tx.query(`INSERT INTO kortix.artifact_doc_state (artifact_id, next_seq, flushed_seq, flushed_version, flushed_markdown, bytes_total)
      VALUES ($1, 3, 1, 'v2', 'new', 7)`, [artifactId]);
    await tx.query(`INSERT INTO kortix.artifact_doc_updates (artifact_id, seq, epoch, bytes)
      SELECT $1, seq, (SELECT epoch FROM kortix.artifact_doc_state WHERE artifact_id = $1), decode(hex, 'hex')
        FROM (VALUES (1, '61616161'), (2, '626262')) AS v(seq, hex)`, [artifactId]);
  };
  const newEpoch = async (artifactId: string) => ({
    rows: (await db.execute(sql`select seq::int as seq, encode(bytes, 'hex') as hex from kortix.artifact_doc_updates
      where artifact_id = ${artifactId}::uuid order by seq`) as unknown as Array<{ seq: number; hex: string }>).map((row) => ({ ...row })),
    bytesTotal: (await db.select({ total: artifactDocState.bytesTotal }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)))[0]?.total,
  });

  test('a reset and re-seed that commit after the step planned and before it writes: the step aborts (stale) and the new epoch keeps its rows and bytes_total', async () => {
    const artifactId = await bigDoc();
    // The step plans on the old epoch (its reads do not wait), then waits on the open reset at its first write.
    const outcome = await interleave(resetAndReseed(artifactId), () => compactArtifactDoc(artifactId), 'artifact_doc');
    expect(outcome).toEqual({ done: false, reason: 'stale' });
    expect(await newEpoch(artifactId)).toEqual({ rows: [{ seq: 1, hex: '61616161' }, { seq: 2, hex: '626262' }], bytesTotal: 7 });
  }, 30_000);

  test('the GC job racing a reset and re-seed: it skips the locked state, and the new epoch keeps its rows and bytes_total', async () => {
    const artifactId = await bigDoc();
    await db.update(artifactDocState).set({ flushedSeq: DOC_COMPACT_ROWS + 1, updatedAt: sql`now() - interval '1 hour'` }).where(eq(artifactDocState.artifactId, artifactId));
    const swept = await interleave(resetAndReseed(artifactId), () => gcArtifactDocs(), 'artifact_doc');
    expect(swept.deleted).not.toContain(artifactId);
    expect(await newEpoch(artifactId)).toEqual({ rows: [{ seq: 1, hex: '61616161' }, { seq: 2, hex: '626262' }], bytesTotal: 7 });
  }, 30_000);

  test('the GC job deletes only the state rows it locked; their epoch’s update rows go with them by foreign key', async () => {
    const artifactId = await bigDoc();
    await db.update(artifactDocState).set({ flushedSeq: DOC_COMPACT_ROWS + 1, updatedAt: sql`now() - interval '1 hour'` }).where(eq(artifactDocState.artifactId, artifactId));
    expect((await gcArtifactDocs()).deleted).toContain(artifactId);
    const after = await newEpoch(artifactId);
    expect({ rows: after.rows, state: after.bytesTotal === undefined ? 'gone' : 'kept' }).toEqual({ rows: [], state: 'gone' });
  });

  test('an update row must name its state’s current epoch (foreign key): a row of another epoch cannot be stored', async () => {
    const artifactId = await bigDoc();
    const stored = await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, epoch, bytes)
      values (${artifactId}::uuid, 9999, gen_random_uuid(), decode('0000', 'hex'))`).then(() => 'stored', (e: unknown) => String((e as { cause?: { code?: string } }).cause?.code ?? e));
    expect(stored).toBe('23503');
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
      ['flushed', true, (id) => markArtifactDocFlushed(id, { holder: 'tab-a', userId, seq: 1, version: 'v2', currentVersion: 'v2', markdown: '' })],
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
    await mismatch(markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', currentVersion: 'v2', markdown: 'two', epoch: stale }));
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', currentVersion: 'v2', markdown: 'two', epoch })).toMatchObject({ flushedSeq: 3 });
  });
});

describe('who wrote (pending writers: each person’s last pushed seq)', () => {
  test('two writers push, the leader flushes: the flush names both writers and the seq range, then clears the list', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });

    const first = await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 4, version: 'v2', currentVersion: 'v2', markdown: 'two' });
    expect({ ...first, contributors: [...first.contributors].sort() }).toEqual({ flushedSeq: 4, contributors: [userId, otherUserId].sort(), fromSeq: 2, toSeq: 4 });
    // Nothing pushed since: the next flush names nobody.
    expect(await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 4, version: 'v3', currentVersion: 'v3', markdown: 'two' }))
      .toEqual({ flushedSeq: 4, contributors: [], fromSeq: 5, toSeq: 4 });
    // An older seq sets nothing and names nobody.
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v0', currentVersion: 'v0', markdown: 'old' })).contributors).toEqual([]);
  });

  test('a flush that does not reach a writer’s LAST push keeps that writer pending; the flush that covers it names them once', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 2, version: 'v2', currentVersion: 'v2', markdown: 'two' })).contributors).toEqual([]);
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v3', currentVersion: 'v3', markdown: 'three' })).contributors).toEqual([otherUserId]);
    expect((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v4', currentVersion: 'v4', markdown: 'three' })).contributors).toEqual([]);
  });

  test('the lease holder flushes S = 2, 3, 4, 5 one at a time, each twice: every writer is named exactly once, and the map ends empty', async () => {
    const artifactId = await newDoc();
    const thirdUserId = crypto.randomUUID();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId }); // 2
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId }); // 3
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId }); // 4
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: thirdUserId }); // 5
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    const named: string[][] = [];
    for (const seq of [2, 3, 4, 5]) {
      for (const save of ['a', 'b']) {
        const version = `v${seq}${save}`;
        named.push((await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq, version, currentVersion: version, markdown: 'text' })).contributors);
      }
    }
    expect(named).toEqual([[], [], [userId], [], [otherUserId], [], [thirdUserId], []]);
    const [state] = await db.select({ pending: artifactDocState.pendingWriters }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    expect(state!.pending).toEqual({});
  });

  test('a merged (compacted) row names no single author', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, epoch, bytes, created_by)
      select ${artifactId}::uuid, g, (select epoch from kortix.artifact_doc_state where artifact_id = ${artifactId}::uuid), decode('0000', 'hex'), ${otherUserId}::uuid from generate_series(2, ${DOC_COMPACT_ROWS + 1}) g`);
    await db.update(artifactDocState).set({ nextSeq: DOC_COMPACT_ROWS + 2 }).where(eq(artifactDocState.artifactId, artifactId));
    expect((await compactArtifactDoc(artifactId)).done).toBe(true);
    const rows = await db.select({ createdBy: artifactDocUpdates.createdBy }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    expect(rows).toEqual([{ createdBy: null }]);
  }, 30_000);
});

describe('a flush is only what the file holds now (replays name nobody)', () => {
  const editRows = async (artifactId: string) => Number((await db.execute(sql`select count(*)::int as n from kortix.audit_events
    where resource_id = ${artifactId} and action = 'project.artifact.doc.edit'`) as unknown as Array<{ n: number }>)[0]!.n);

  test('two writers, one flush at the file’s current version → two project.artifact.doc.edit rows; a replay or an equal seq → none; another version → 409 version_mismatch', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: otherUserId });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId });
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    const flush = (seq: number, version: string, currentVersion: string | null) =>
      markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq, version, markdown: 'two', currentVersion });
    const record = async (result: Awaited<ReturnType<typeof flush>>, version: string) =>
      recordArtifactDocEdits({ accountId, projectId, artifactId, flushedBy: userId, version, flush: result });

    const first = await flush(3, 'v2', 'v2');
    expect([...first.contributors].sort()).toEqual([userId, otherUserId].sort());
    await record(first, 'v2');
    expect(await editRows(artifactId)).toBe(2);

    // The same call again, and a save of the same seq under a newer version: the file holds no new writer's text.
    const replay = await flush(3, 'v2', 'v2');
    expect(replay.contributors).toEqual([]);
    await record(replay, 'v2');
    const resaved = await flush(3, 'v3', 'v3');
    expect(resaved.contributors).toEqual([]);
    await record(resaved, 'v3');
    expect(await editRows(artifactId)).toBe(2);

    // A version the file does not have now (a replay of an old flush, or an invented one), or a doc without a file.
    const refused = await flush(3, 'v2', 'v3').then(() => null, (e: unknown) => e as ArtifactDocError);
    expect({ status: refused?.status, code: refused?.code, detail: refused?.detail }).toEqual({ status: 409, code: 'version_mismatch', detail: { current_version: 'v3' } });
    await rejects(flush(3, 'v3', null), 409, 'version_mismatch');
    expect((await readArtifactDoc(artifactId, { after: 3, base: true })).flushed).toEqual({ seq: 3, version: 'v3', markdown: 'two' });
  });

  test('the pending map holds at most 200 writers, so one flush names at most 200', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
    for (let i = 0; i < 205; i++) await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId: crypto.randomUUID() });
    const [state] = await db.select({ pending: artifactDocState.pendingWriters }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId));
    expect(Object.keys(state!.pending)).toHaveLength(200);
    await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
    const flushed = await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 206, version: 'v2', markdown: '', currentVersion: 'v2' });
    expect(flushed.contributors).toHaveLength(200);
  }, 30_000);
});

describe('a page counts structs', () => {
  test('rows whose struct counts pass the page’s struct budget go on the next page; every row stores its count', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId, structs: 0 });
    const heavy = Math.floor(DOC_PAGE_MAX_STRUCTS * 0.6);
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, structs: heavy });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, structs: heavy });
    await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, structs: 10 });
    const first = await readArtifactDoc(artifactId, { after: 0, base: false });
    expect({ seqs: first.updates.map((u) => u.seq), hasMore: first.hasMore }).toEqual({ seqs: [1, 2], hasMore: true });
    const second = await readArtifactDoc(artifactId, { after: 2, base: false });
    expect({ seqs: second.updates.map((u) => u.seq), hasMore: second.hasMore }).toEqual({ seqs: [3, 4], hasMore: false });
    const counts = await db.select({ seq: artifactDocUpdates.seq, structs: artifactDocUpdates.structs }).from(artifactDocUpdates)
      .where(eq(artifactDocUpdates.artifactId, artifactId)).orderBy(artifactDocUpdates.seq);
    expect(counts.map((r) => r.structs)).toEqual([0, heavy, heavy, 10]);
  });
});

describe('the root index: an item placed by its origin at the root must be an XML element', () => {
  /** An update as the route passes it: the bytes, their struct count, and where the structs go. */
  const placed = (update: Uint8Array | string, kind: 'push' | 'seed') => {
    const bytes = typeof update === 'string' ? new Uint8Array(Buffer.from(update, 'base64')) : update;
    const scanned = placeDocUpdate(bytes, kind);
    if (!scanned.ok) throw new Error(`scan refused: ${scanned.reason}`);
    return { update: Buffer.from(bytes), structs: scanned.structs, placement: scanned.placement };
  };
  const reason = async (run: Promise<unknown>) => {
    const error = (await run.then(() => null, (e: unknown) => e)) as ArtifactDocError | null;
    return error && { status: error.status, code: error.code, reason: error.detail?.reason };
  };
  const roots = async (artifactId: string) => (await db.execute(sql`select client::text || ':' || clock::text as id from kortix.artifact_doc_roots
    where artifact_id = ${artifactId}::uuid order by 1`) as unknown as Array<{ id: string }>).map((row) => row.id);
  const clients = async (artifactId: string) => Number((await db.execute(sql`select count(*)::int as n from kortix.artifact_doc_clients
    where artifact_id = ${artifactId}::uuid`) as unknown as Array<{ n: number }>)[0]!.n);

  // A seed by client 4131944473: one paragraph at the root, at clock 0 (header 01 01 <client> 00, then the item).
  const STRIX_CLIENT_SEED = new Uint8Array([1, 1, 0x99, 0xf0, 0xa1, 0xb2, 0x0f, 0, 7, 1, 7, ...Buffer.from('default'), 3, 9, ...Buffer.from('paragraph'), 0]);
  /** Strix's 27 bytes: an XML text placed after 4131944473:0 (so at the root), then text inside it. */
  const STRIX = 'AQKj4fJVAIeZ8KGyDwAGBACj4fJVAANwd24A';

  test('Strix’s 27-byte payload after a seed whose root holds its origin → 400 invalid_update root_not_element, and nothing is stored', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { ...placed(STRIX_CLIENT_SEED, 'seed'), markdown: '', version: 'v1', userId });
    expect(await roots(artifactId)).toEqual(['4131944473:0']);
    expect(await reason(appendArtifactDocUpdate(artifactId, { ...placed(STRIX, 'push'), userId })))
      .toEqual({ status: 400, code: 'invalid_update', reason: 'root_not_element' });
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).latestSeq).toBe(1);
    expect(await roots(artifactId)).toEqual(['4131944473:0']);
  });

  test('the same bytes on a doc that never had that origin → 400 unknown_origin', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { ...placed(EDITOR_BLOCK_SEED, 'seed'), markdown: '', version: 'v1', userId });
    expect(await reason(appendArtifactDocUpdate(artifactId, { ...placed(STRIX, 'push'), userId })))
      .toEqual({ status: 400, code: 'invalid_update', reason: 'unknown_origin' });
  });

  test('the real editor’s block edits (insert, split, join, delete, undo, redo, Enter, delete all) all pass; the index equals what Yjs places at the root; a reset clears it', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { ...placed(EDITOR_BLOCK_SEED, 'seed'), markdown: '', version: 'v1', userId });
    for (const push of EDITOR_BLOCK_PUSHES) await appendArtifactDocUpdate(artifactId, { ...placed(push.update, 'push'), userId });
    // A retry of the last push (its answer lost) passes and changes nothing.
    await appendArtifactDocUpdate(artifactId, { ...placed(EDITOR_BLOCK_PUSHES.at(-1)!.update, 'push'), userId });

    const doc = new Y.Doc({ gc: false });
    for (const update of [EDITOR_BLOCK_SEED, ...EDITOR_BLOCK_PUSHES.map((push) => push.update)]) Y.applyUpdate(doc, Buffer.from(update, 'base64'));
    const truth: string[] = [];
    for (let item = doc.getXmlFragment('default')._start; item; item = item.right) truth.push(`${item.id.client}:${item.id.clock}`);
    expect(await roots(artifactId)).toEqual(truth.sort());
    expect(await clients(artifactId)).toBe(2);

    await resetArtifactDoc(artifactId, { holder: 'tab-a', userId });
    expect({ roots: await roots(artifactId), clients: await clients(artifactId) }).toEqual({ roots: [], clients: 0 });
  });

  test('the GC job and a delete of the Artifact clear the index with the state', async () => {
    const collected = await newDoc();
    const deleted = await newDoc();
    for (const artifactId of [collected, deleted]) {
      await seedArtifactDoc(artifactId, { ...placed(EDITOR_BLOCK_SEED, 'seed'), markdown: '', version: 'v1', userId });
      expect({ roots: (await roots(artifactId)).length > 0, clients: await clients(artifactId) }).toEqual({ roots: true, clients: 1 });
    }
    await db.update(artifactDocState).set({ updatedAt: sql`now() - interval '1 hour'` }).where(eq(artifactDocState.artifactId, collected));
    expect((await gcArtifactDocs()).deleted).toContain(collected);
    await db.delete(artifacts).where(eq(artifacts.artifactId, deleted));
    for (const artifactId of [collected, deleted]) expect({ roots: await roots(artifactId), clients: await clients(artifactId) }).toEqual({ roots: [], clients: 0 });
  });

  test('a push that starts past its client’s stored clocks → 400 clock_gap', async () => {
    const artifactId = await newDoc();
    await seedArtifactDoc(artifactId, { ...placed(EDITOR_BLOCK_SEED, 'seed'), markdown: '', version: 'v1', userId });
    expect(await reason(appendArtifactDocUpdate(artifactId, { ...placed(EDITOR_BLOCK_PUSHES[1]!.update, 'push'), userId })))
      .toEqual({ status: 400, code: 'invalid_update', reason: 'clock_gap' });
  });
});
