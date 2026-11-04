import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, artifactDocState, artifactDocUpdates, artifacts, drives, projects } from '@kortix/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { localTestDatabaseUrl } from '../__tests__/helpers/integration-fixtures';
import { PgClient } from '../__tests__/helpers/pg-client';
import { gcArtifactDocs } from './doc-gc';
import { appendArtifactDocUpdate, leaseArtifactDoc, markArtifactDocFlushed, seedArtifactDoc } from './doc-service';

const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
let projectId = '';
let driveId = '';

async function newDoc(): Promise<string> {
  const [row] = await db.insert(artifacts).values({
    accountId, projectId, driveId, root: `/Company/Artifacts/${crypto.randomUUID()}`, entry: 'index.md', folder: true,
    type: 'doc', title: 'Doc GC', visibility: 'project', createdByUserId: userId,
  }).returning({ artifactId: artifacts.artifactId });
  return row!.artifactId;
}

/** A seeded doc with two pushes, its lease taken and released, everything flushed, idle for `idleMinutes`. */
async function flushedDoc(idleMinutes: number): Promise<string> {
  const artifactId = await newDoc();
  await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: 'one', version: 'v1', userId });
  await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId });
  await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId });
  await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: false });
  await markArtifactDocFlushed(artifactId, { holder: 'tab-a', userId, seq: 3, version: 'v2', markdown: 'two' });
  await leaseArtifactDoc(artifactId, { holder: 'tab-a', userId, release: true });
  await idle(artifactId, idleMinutes);
  return artifactId;
}

async function idle(artifactId: string, minutes: number): Promise<void> {
  await db.update(artifactDocState)
    .set({ updatedAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(artifactDocState.artifactId, artifactId));
}

async function present(ids: string[]): Promise<{ states: string[]; rows: number }> {
  const states = await db.select({ id: artifactDocState.artifactId }).from(artifactDocState).where(inArray(artifactDocState.artifactId, ids));
  const [rows] = await db.select({ n: sql<number>`count(*)::int` }).from(artifactDocUpdates).where(inArray(artifactDocUpdates.artifactId, ids));
  return { states: states.map((s) => s.id).sort(), rows: Number(rows!.n) };
}

beforeAll(async () => {
  localTestDatabaseUrl();
  await db.insert(accounts).values({ accountId, name: 'Doc GC test' });
  const [project] = await db.insert(projects).values({ accountId, name: 'Doc GC', repoUrl: 'https://example.test/doc-gc.git' }).returning();
  projectId = project!.projectId;
  const [drive] = await db.insert(drives).values({ accountId, projectId, kind: 'project', name: 'Doc GC fixture', platinumVolumeName: `test-doc-gc-${crypto.randomUUID()}` }).returning();
  driveId = drive!.driveId;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('the doc GC job', () => {
  test('deletes an idle, flushed doc with no live lease (state and rows); keeps every doc that fails one condition', async () => {
    const gone = await flushedDoc(11);
    // Its tab died: the lease expired 11 minutes ago and was never released.
    const expired = await flushedDoc(11);
    await leaseArtifactDoc(expired, { holder: 'tab-b', userId, release: false });
    await db.update(artifactDocState).set({ leaseExpiresAt: sql`now() - interval '11 minutes'` }).where(eq(artifactDocState.artifactId, expired));
    await idle(expired, 11);

    // Not flushed: seq 4 is not in the file.
    const unflushed = await flushedDoc(0);
    await appendArtifactDocUpdate(unflushed, { update: Buffer.from([0, 0]), userId });
    await idle(unflushed, 30);
    // A live lease (a tab is open, though nobody typed for 30 min).
    const leased = await flushedDoc(0);
    await leaseArtifactDoc(leased, { holder: 'tab-c', userId, release: false });
    await idle(leased, 30);
    // The lease ended only 5 minutes ago.
    const recentLease = await flushedDoc(0);
    await leaseArtifactDoc(recentLease, { holder: 'tab-d', userId, release: false });
    await db.update(artifactDocState).set({ leaseExpiresAt: sql`now() - interval '5 minutes'` }).where(eq(artifactDocState.artifactId, recentLease));
    await idle(recentLease, 30);
    // Flushed and free, but used 5 minutes ago.
    const recent = await flushedDoc(5);

    const ids = [gone, expired, unflushed, leased, recentLease, recent];
    const result = await gcArtifactDocs();
    expect(result.deleted.filter((id) => ids.includes(id)).sort()).toEqual([gone, expired].sort());
    expect(await present([gone, expired])).toEqual({ states: [], rows: 0 });
    const kept = [unflushed, leased, recentLease, recent];
    expect(await present(kept)).toEqual({ states: [...kept].sort(), rows: 3 * 3 + 4 });
  });

  test('bounded per tick: batchSize × maxBatches docs at most', async () => {
    const docs = await Promise.all([flushedDoc(20), flushedDoc(20), flushedDoc(20)]);
    const first = await gcArtifactDocs({ batchSize: 1, maxBatches: 2 });
    expect(first.deleted.filter((id) => docs.includes(id))).toHaveLength(2);
    expect((await present(docs)).states).toHaveLength(1);
    await gcArtifactDocs({ batchSize: 1, maxBatches: 2 });
    expect(await present(docs)).toEqual({ states: [], rows: 0 });
  });

  test('a doc whose state another transaction holds is skipped (SKIP LOCKED), not waited on', async () => {
    const [locked, free] = await Promise.all([flushedDoc(20), flushedDoc(20)]);
    const tx = new PgClient({ connectionString: process.env.TEST_DATABASE_URL });
    await tx.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT 1 FROM kortix.artifact_doc_state WHERE artifact_id = $1 FOR UPDATE', [locked]);
      const started = Date.now();
      const result = await gcArtifactDocs();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result.deleted).toContain(free);
      expect(result.deleted).not.toContain(locked);
      await tx.query('COMMIT');
    } finally {
      await tx.end();
    }
    expect((await present([locked])).states).toEqual([locked]);
  });
});
