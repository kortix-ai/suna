/**
 * Lazy approval enrichment (real Postgres). A pending row held before its
 * action had an enricher reads its content once, on a by-id read, and stores
 * `resolved_preview` + `resolved_digest` in `result_summary`. A second read,
 * a row that already carries the keys, a decided or expired row, or an action
 * without an enricher runs nothing and writes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectorCalls } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import type { ApprovalEnricherContext } from '../connectors/approval-enrichers';
import { enrichPendingCallOnce } from '../connectors/approval-enrich-pending';
import { db } from '../shared/db';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const KEY = 'composio:GMAIL_SEND_DRAFT';
const DRAFT = { from: 'ops@example.test', to: 'buyer@example.test', subject: 'Quote', body: 'Hello' };

let seeded: SeededProject;
let reads = 0;
const enrichers = {
  [KEY]: async () => {
    reads += 1;
    return DRAFT;
  },
};
const contextFor = async () => ({ key: KEY, ctx: {} as ApprovalEnricherContext });

type CallInsert = typeof connectorCalls.$inferInsert;
/** Overrides may carry SQL (`expires_at` on the database clock). */
async function seed(values: { [K in keyof CallInsert]?: CallInsert[K] | ReturnType<typeof sql> } = {}) {
  const [row] = await db
    .insert(connectorCalls)
    .values({
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      actionPath: 'gmail.send_draft',
      status: 'pending_approval',
      resultSummary: { args_preview: { draft_id: 'r-1' }, args_preview_complete: true },
      expiresAt: sql`now() + interval '1 hour'`,
      ...values,
    })
    .returning();
  return row;
}
const summaryOf = async (executionId: string) => {
  const [row] = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, executionId));
  return row.resultSummary as Record<string, unknown>;
};

beforeAll(async () => {
  seeded = await seedProject('approval-lazy-enrich');
}, 30_000);

afterAll(async () => {
  await db.delete(connectorCalls).where(eq(connectorCalls.projectId, seeded.project_id));
  await removeSeeded([seeded]);
}, 30_000);

describe('enrichPendingCallOnce', () => {
  test('reads the content once, persists preview and digest, then serves the stored copy', async () => {
    reads = 0;
    const row = await seed();
    const served = (await enrichPendingCallOnce(row, { enrichers, contextFor })) as Record<string, unknown>;
    expect(served.resolved_preview).toEqual(DRAFT);
    expect(served.resolved_digest).toMatch(/^[a-f0-9]{64}$/);
    const stored = await summaryOf(row.executionId);
    expect(stored).toEqual({ ...(row.resultSummary as object), resolved_preview: DRAFT, resolved_digest: served.resolved_digest });

    const reread = await db.select().from(connectorCalls).where(eq(connectorCalls.executionId, row.executionId));
    expect(await enrichPendingCallOnce(reread[0], { enrichers, contextFor })).toEqual(stored);
    expect(reads).toBe(1);
  });

  test('a failed read stores resolved_error once', async () => {
    const row = await seed();
    const failing = { [KEY]: async () => null };
    await enrichPendingCallOnce(row, { enrichers: failing, contextFor });
    expect((await summaryOf(row.executionId)).resolved_error).toBe('unavailable');
  });

  test('skips a row with stored keys, a decided row, an expired row, and an action without an enricher', async () => {
    reads = 0;
    const withError = await seed({ resultSummary: { args_preview: { draft_id: 'r-1' }, resolved_error: 'unavailable' } });
    const decided = await seed({ status: 'ok' });
    const expired = await seed({ expiresAt: sql`now() - interval '1 minute'` });
    for (const row of [withError, decided, expired]) {
      expect(await enrichPendingCallOnce(row, { enrichers, contextFor })).toEqual(row.resultSummary);
      expect(await summaryOf(row.executionId)).toEqual(row.resultSummary as Record<string, unknown>);
    }
    const noEnricher = await seed({ actionPath: 'github.merge_pull_request' });
    await enrichPendingCallOnce(noEnricher, {
      enrichers,
      contextFor: async () => ({ key: 'composio:GITHUB_MERGE_A_PULL_REQUEST', ctx: {} as ApprovalEnricherContext }),
    });
    expect(await summaryOf(noEnricher.executionId)).toEqual(noEnricher.resultSummary as Record<string, unknown>);
    expect(reads).toBe(0);
  });

  test('a row decided between the read and the write keeps its decided summary', async () => {
    const row = await seed();
    await db.update(connectorCalls).set({ status: 'ok' }).where(eq(connectorCalls.executionId, row.executionId));
    await enrichPendingCallOnce(row, { enrichers, contextFor });
    expect(await summaryOf(row.executionId)).toEqual(row.resultSummary as Record<string, unknown>);
  });
});
