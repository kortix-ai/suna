/**
 * A review_item_id that is not a UUID must never reach the uuid-typed column:
 * Postgres answers 22P02 ("invalid input syntax for type uuid") and the route
 * dies as an opaque 500. Better Stack pattern f457fabc (KRTX-2442): a client
 * sent `nonexistent-item` to POST /review/bulk (update) and
 * POST /review/items/{id}/act (select) on API dev, 5 times in 2 minutes.
 *
 * The helpers the routes call answer "not found" instead — the same shape a
 * valid-but-missing uuid already gets (`getInboxItem` returns null for an id
 * that is not a uuid).
 *
 * Real Postgres: the bug IS the cast Postgres rejects, so only a real database
 * proves the fix.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { projects, reviewItems } from '@kortix/db';
import { applyVerdict, bulkApplyVerdict, getReviewItemById } from '../projects/review-items';
import { db } from '../shared/db';
import { removeSeeded, seedProject } from './helpers/integration-fixtures';

/** The exact value the dev probe sent, verbatim from the Better Stack rows. */
const GARBAGE = 'nonexistent-item';
const ACTOR = crypto.randomUUID();

let seeded: Awaited<ReturnType<typeof seedProject>> | null = null;
let itemId = '';

beforeAll(async () => {
  seeded = await seedProject('review-items-nonuuid');
  await db.insert(reviewItems).values({
    accountId: seeded.account_id,
    projectId: seeded.project_id,
    kind: 'output',
    status: 'needs_you',
    title: 'a real item',
    createdBy: ACTOR,
  });
  const [row] = await db
    .select({ id: reviewItems.reviewItemId })
    .from(reviewItems)
    .where(eq(reviewItems.projectId, seeded.project_id))
    .limit(1);
  itemId = row.id;
});

afterAll(async () => {
  if (seeded) await removeSeeded([seeded]);
});

describe('review items answer a non-uuid id like a miss (KRTX-2442)', () => {
  test('getReviewItemById answers null, like any miss', async () => {
    expect(await getReviewItemById(GARBAGE, seeded!.project_id)).toBeNull();
    // Parity: a well-formed uuid that does not exist gets the same answer.
    expect(await getReviewItemById(crypto.randomUUID(), seeded!.project_id)).toBeNull();
  });

  test('applyVerdict answers null instead of throwing 22P02', async () => {
    const row = await applyVerdict(GARBAGE, seeded!.project_id, {
      verdict: 'approve',
      actingUserId: ACTOR,
    });
    expect(row).toBeNull();
  });

  test('bulkApplyVerdict answers [] instead of throwing 22P02', async () => {
    const rows = await bulkApplyVerdict([GARBAGE], seeded!.project_id, {
      verdict: 'approve',
      actingUserId: ACTOR,
    });
    expect(rows).toEqual([]);
  });

  test('bulkApplyVerdict drops only the garbage ids; the real ones still update', async () => {
    const rows = await bulkApplyVerdict([itemId, GARBAGE], seeded!.project_id, {
      verdict: 'dismiss',
      actingUserId: ACTOR,
    });
    expect(rows.map((row) => row.reviewItemId)).toEqual([itemId]);
  });
});
