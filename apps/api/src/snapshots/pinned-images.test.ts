import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, accounts, projects, type Database } from '@kortix/db';
import { collectPinnedImageRefs } from './pinned-images';

// Throwaway-Postgres proof that the pinned-image guard reads the ACTIVE pin keys
// (active_sandbox_snapshot_name + active_sandbox_external_template_id) written by
// activation, so the reaper/quota-GC can protect a live pinned image by NAME or id.

const DB_URL = process.env.PTX_TEST_DB_URL;
const RUN = !!DB_URL;
const d = RUN ? describe : describe.skip;

let db: Database;
let accountId: string;

async function project(metadata: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ accountId, name: 'pin', repoUrl: 'https://example.test/r.git', metadata })
    .returning();
  return row!.projectId;
}

beforeAll(async () => {
  if (!RUN) return;
  db = createDb(DB_URL!);
  const [acct] = await db.insert(accounts).values({ name: 'pinned-images-test' }).returning();
  accountId = acct!.accountId;
});

afterAll(async () => {
  if (!RUN) return;
  await db.delete(accounts).where(eq(accounts.accountId, accountId));
});

d('collectPinnedImageRefs (throwaway Postgres)', () => {
  test('returns the active pinned image NAME and external id, and ignores unpinned projects', async () => {
    await project({
      default_sandbox_provider: 'platinum',
      active_sandbox_snapshot_name: 'kortix-ppwarm-abcd1234-deadbeefcafe',
      active_sandbox_external_template_id: 'tpl_live_123',
    });
    // A project with an EXTERNAL id but no snapshot name (e.g. a default-provider pin).
    await project({ active_sandbox_external_template_id: 'tpl_only_456' });
    // An unpinned project contributes nothing.
    await project({ default_agent: 'writer', triggers_paused: true });

    const refs = await collectPinnedImageRefs(db);
    expect(refs.has('kortix-ppwarm-abcd1234-deadbeefcafe')).toBe(true);
    expect(refs.has('tpl_live_123')).toBe(true);
    expect(refs.has('tpl_only_456')).toBe(true);
    // No stray values from the unpinned project.
    expect(refs.has('writer')).toBe(false);
  });
});
