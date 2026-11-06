/**
 * A review item's verdict decides it once (real PostgreSQL).
 *
 * `applyVerdict` / `bulkApplyVerdict` wrote `WHERE review_item_id = ?` with
 * no status guard, so any verdict applied from any state: a second reviewer,
 * a Slack click and a web click that raced, or a click on an old card,
 * reversed a human decision (`rejected -> approved`) and overwrote `acted_by`
 * and `feedback`. Verdicts are now a compare-and-set on the open statuses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { reviewItems } from '@kortix/db';
import { applyVerdict, bulkActReview, bulkApplyVerdict } from '../projects/review-items';
import { db } from '../shared/db';
import { removeSeeded, seedProject } from './helpers/integration-fixtures';
import { interleave } from './helpers/interleave';

const FIRST = crypto.randomUUID();
const SECOND = crypto.randomUUID();

let seeded: Awaited<ReturnType<typeof seedProject>> | null = null;

async function newItem(): Promise<string> {
  const [row] = await db
    .insert(reviewItems)
    .values({
      accountId: seeded!.account_id,
      projectId: seeded!.project_id,
      kind: 'output',
      status: 'needs_you',
      title: 'verdict once',
      createdBy: FIRST,
    })
    .returning({ id: reviewItems.reviewItemId });
  return row!.id;
}

async function read(id: string) {
  const [row] = await db
    .select({ status: reviewItems.status, actedBy: reviewItems.actedBy, feedback: reviewItems.feedback })
    .from(reviewItems)
    .where(eq(reviewItems.reviewItemId, id));
  return row;
}

beforeAll(async () => {
  seeded = await seedProject('review-verdict-once');
});

afterAll(async () => {
  if (seeded) await removeSeeded([seeded]);
});

describe('a review verdict decides an open item once', () => {
  test('a second verdict on a decided item changes nothing', async () => {
    const id = await newItem();
    const first = await applyVerdict(id, seeded!.project_id, { verdict: 'reject', feedback: 'no', actingUserId: FIRST });
    expect(first?.status).toBe('rejected');
    const second = await applyVerdict(id, seeded!.project_id, { verdict: 'approve', actingUserId: SECOND });
    expect(second).toBeNull();
    expect(await read(id)).toEqual({ status: 'rejected', actedBy: FIRST, feedback: 'no' });
  });

  test('a verdict that read the item open before another verdict committed loses', async () => {
    const id = await newItem();
    const result = await interleave(
      (tx) =>
        tx.query(
          `UPDATE kortix.review_items SET status = 'rejected', acted_by = $2, feedback = 'first' WHERE review_item_id = $1`,
          [id, FIRST],
        ),
      () => applyVerdict(id, seeded!.project_id, { verdict: 'approve', actingUserId: SECOND }),
      'review_items',
    );
    expect(result).toBeNull();
    expect(await read(id)).toEqual({ status: 'rejected', actedBy: FIRST, feedback: 'first' });
  });

  test('a bulk verdict skips decided items and reports them already resolved', async () => {
    const open = await newItem();
    const decided = await newItem();
    await applyVerdict(decided, seeded!.project_id, { verdict: 'dismiss', actingUserId: FIRST });
    const rows = await bulkApplyVerdict([open, decided], seeded!.project_id, { verdict: 'approve', actingUserId: SECOND });
    expect(rows.map((row) => row.reviewItemId)).toEqual([open]);
    expect((await read(decided))?.status).toBe('dismissed');

    const again = await bulkActReview([open, decided, crypto.randomUUID()], seeded!.project_id, {
      verdict: 'reject',
      accountId: seeded!.account_id,
      caller: { callerUserId: SECOND } as never,
      auditSource: 'test',
    });
    expect(again.results.map((r) => r.code ?? 'ok')).toEqual(['already_resolved', 'already_resolved', 'not_found']);
    expect((await read(open))?.status).toBe('approved');
  });
});
