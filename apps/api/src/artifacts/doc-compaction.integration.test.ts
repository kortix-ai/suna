import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, artifactDocState, artifactDocUpdates, artifacts, drives, projects } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { localTestDatabaseUrl } from '../__tests__/helpers/integration-fixtures';
import { compactRequestedArtifactDocs } from './doc-compaction';
import { DOC_COMPACT_ROWS, DOC_COMPACT_WINDOW_STRUCTS } from './doc-rules';
import { appendArtifactDocUpdate, readArtifactDoc, seedArtifactDoc } from './doc-service';

const accountId = crypto.randomUUID();
const userId = crypto.randomUUID();
let projectId = '';
let driveId = '';

async function newDoc(): Promise<string> {
  const [row] = await db.insert(artifacts).values({
    accountId, projectId, driveId, root: `/Company/Artifacts/${crypto.randomUUID()}`, entry: 'index.md', folder: true,
    type: 'doc', title: 'Doc compaction', visibility: 'project', createdByUserId: userId,
  }).returning({ artifactId: artifacts.artifactId });
  return row!.artifactId;
}

/** A seeded doc with `rows` - 1 rows inserted past the push path (`structs` each), then one real push. */
async function docWithRows(rows: number, structs: number): Promise<string> {
  const artifactId = await newDoc();
  await seedArtifactDoc(artifactId, { update: Buffer.from([0, 0]), markdown: '', version: 'v1', userId });
  await db.execute(sql`insert into kortix.artifact_doc_updates (artifact_id, seq, bytes, structs)
    select ${artifactId}::uuid, g, decode('0000', 'hex'), ${structs} from generate_series(2, ${rows - 1}) g`);
  await db.update(artifactDocState).set({ nextSeq: rows }).where(eq(artifactDocState.artifactId, artifactId));
  await appendArtifactDocUpdate(artifactId, { update: Buffer.from([0, 0]), userId, structs });
  return artifactId;
}

const requested = async (artifactId: string) =>
  (await db.select({ at: artifactDocState.compactionRequestedAt }).from(artifactDocState).where(eq(artifactDocState.artifactId, artifactId)))[0]!.at;
const liveRows = async (artifactId: string) =>
  Number((await db.select({ n: sql<number>`count(*)::int` }).from(artifactDocUpdates)
    .where(and(eq(artifactDocUpdates.artifactId, artifactId), isNull(artifactDocUpdates.quarantinedAt))))[0]!.n);

beforeAll(async () => {
  localTestDatabaseUrl();
  await db.insert(accounts).values({ accountId, name: 'Doc compaction test' });
  const [project] = await db.insert(projects).values({ accountId, name: 'Doc compaction', repoUrl: 'https://example.test/doc-compaction.git' }).returning();
  projectId = project!.projectId;
  const [drive] = await db.insert(drives).values({ accountId, projectId, kind: 'project', name: 'Doc compaction fixture', platinumVolumeName: `test-doc-compaction-${crypto.randomUUID()}` }).returning();
  driveId = drive!.driveId;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

describe('compaction runs on the worker, never in a push', () => {
  test('a push past the row threshold only marks the doc: no row is merged in the request', async () => {
    const artifactId = await docWithRows(DOC_COMPACT_ROWS + 1, 0);
    expect(await requested(artifactId)).toBeInstanceOf(Date);
    expect(await liveRows(artifactId)).toBe(DOC_COMPACT_ROWS + 1);
  });

  test('the worker tick compacts a marked doc below the threshold and clears the mark', async () => {
    const artifactId = await docWithRows(DOC_COMPACT_ROWS + 1, 0);
    const result = await compactRequestedArtifactDocs({ budgetMs: 5_000 });
    expect(result.compacted).toContain(artifactId);
    expect(await liveRows(artifactId)).toBe(1);
    expect(await requested(artifactId)).toBeNull();
    expect((await readArtifactDoc(artifactId, { after: 0, base: false })).updates.map((u) => u.seq)).toEqual([DOC_COMPACT_ROWS + 1]);
  });

  test(`heavy rows compact one small window at a time (at most ${DOC_COMPACT_WINDOW_STRUCTS} structs per merged row); a spent time budget stops the tick and keeps the mark`, async () => {
    const artifactId = await docWithRows(DOC_COMPACT_ROWS + 1, 8_250);
    // A budget of 0 ms: one step at most, then the tick stops.
    const first = await compactRequestedArtifactDocs({ budgetMs: 0 });
    expect(first.steps).toBeLessThanOrEqual(1);
    expect(await requested(artifactId)).toBeInstanceOf(Date);
    await compactRequestedArtifactDocs({ budgetMs: 10_000 });
    const rows = await db.select({ structs: artifactDocUpdates.structs }).from(artifactDocUpdates).where(eq(artifactDocUpdates.artifactId, artifactId));
    expect(rows.length).toBeLessThanOrEqual(DOC_COMPACT_ROWS);
    expect(Math.max(...rows.map((r) => r.structs))).toBeLessThanOrEqual(DOC_COMPACT_WINDOW_STRUCTS);
    expect(await requested(artifactId)).toBeNull();
  }, 30_000);
});
