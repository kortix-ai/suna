/**
 * DB suite: a project that moved to another workspace (a split or a transfer)
 * keeps its cost history in the workspace it moved to, while the money stays
 * with the account that paid (design.md §3.1 finding 31).
 *
 * The move is written the way project-transfer.ts writes it: the project and
 * its sessions change account, gateway_request_logs and
 * sandbox_compute_sessions stay with the source (PROJECT_TRANSFER_LEAVE_TABLES).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, gatewayRequestLogs, projectSessions, projects, sandboxComputeSessions } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';

import { getCostSummary, listCostByProject } from './cost-rollups';
import { db } from './db';
import { getSessionCostRecord, listProjectGatewaySessionSpend, listSessionCosts } from './session-costs';

const keeper = crypto.randomUUID();
const moved = crypto.randomUUID();
const projectId = crypto.randomUUID();
const sessionId = `ses_moved_${crypto.randomUUID().slice(0, 8)}`;
const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: keeper, name: 'Keeper workspace' },
    { accountId: moved, name: 'Moved workspace' },
  ]);
  await db.insert(projects).values({ projectId, accountId: keeper, name: 'Moved project', repoUrl: 'https://example.test/moved.git' });
  await db.insert(projectSessions).values({ sessionId, projectId, accountId: keeper, branchName: 'main', status: 'stopped' });
  // Spend from before the move, billed to the keeper.
  await db.insert(gatewayRequestLogs).values({
    requestId: crypto.randomUUID(),
    accountId: keeper,
    projectId,
    sessionId,
    requestedModel: 'test-model',
    resolvedModel: 'test-model',
    provider: 'test',
    status: 200,
    ok: true,
    billingMode: 'credits',
    finalCost: '1.5',
  });
  await db.insert(sandboxComputeSessions).values({
    accountId: keeper,
    sandboxId: crypto.randomUUID(),
    sessionId,
    cpuCores: 2,
    memoryGb: 4,
    diskGb: 10,
    state: 'finalized',
    costUsd: '0.5',
  });
  // The move.
  await db.update(projects).set({ accountId: moved }).where(eq(projects.projectId, projectId));
  await db.update(projectSessions).set({ accountId: moved }).where(eq(projectSessions.sessionId, sessionId));
});

afterAll(async () => {
  await db.delete(sandboxComputeSessions).where(eq(sandboxComputeSessions.sessionId, sessionId));
  await db.delete(gatewayRequestLogs).where(eq(gatewayRequestLogs.projectId, projectId));
  await db.delete(projectSessions).where(eq(projectSessions.sessionId, sessionId));
  await db.delete(projects).where(eq(projects.projectId, projectId));
  await db.delete(accounts).where(inArray(accounts.accountId, [keeper, moved]));
});

describe('a moved project keeps its cost history', () => {
  test('the session detail in the workspace it moved to shows its full cost, marked as billed elsewhere', async () => {
    const detail = await getSessionCostRecord({ accountId: moved, sessionId });
    expect(detail).not.toBeNull();
    expect(detail!.llm_cost).toBe(1.5);
    expect(detail!.compute_cost).toBe(0.5);
    expect(detail!.total_cost).toBe(2);
    expect(detail!.billed_elsewhere_cost).toBe(2);
    expect(detail!.ledger_entries.map((entry) => [entry.kind, entry.billed_elsewhere])).toEqual(
      expect.arrayContaining([['llm', true], ['compute', true]]),
    );
    expect(detail!.model_usage.map((usage) => usage.cost)).toEqual([1.5]);
  });

  test("the workspace's session list reads the project's sessions with their cost", async () => {
    const page = await listSessionCosts({ accountId: moved, projectId, window, sort: 'recent', limit: 10, offset: 0 });
    expect(page.sessions.map((row) => [row.session_id, row.total_cost])).toEqual([[sessionId, 2]]);
    expect(page.reconciliation.total_cost).toBe(0);
  });

  test('the project gateway spend reads the project wherever it was billed', async () => {
    const spend = await listProjectGatewaySessionSpend({ accountId: moved, projectId, days: 1 });
    expect(spend.sessions.map((row) => row.session_id)).toEqual([sessionId]);
  });

  test("the payer keeps the money and labels the project 'Moved to another workspace', never by id or new name", async () => {
    const page = await listCostByProject({ accountId: keeper, window, sort: 'total_desc', limit: 10, offset: 0 });
    const row = page.projects.find((p) => p.project_id === projectId);
    expect(row).toMatchObject({ project_name: 'Moved to another workspace', moved: true, llm_cost: 1.5 });
    const summary = await getCostSummary({ accountId: keeper, window });
    expect(summary.totals.llm_cost).toBe(1.5);
  });

  test('the account-wide money view of the moved workspace does not take the payer’s spend', async () => {
    const summary = await getCostSummary({ accountId: moved, window });
    expect(summary.totals.llm_cost).toBe(0);
    expect(summary.totals.compute_cost).toBe(0);
  });
});
