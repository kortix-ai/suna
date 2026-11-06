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
// A third workspace whose request carried the moved project's id (a stale header).
const stranger = crypto.randomUUID();
const strangerProject = crypto.randomUUID();
const strangerSession = `ses_stranger_${crypto.randomUUID().slice(0, 8)}`;
const projectId = crypto.randomUUID();
const sessionId = `ses_moved_${crypto.randomUUID().slice(0, 8)}`;
const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) };

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: keeper, name: 'Keeper workspace' },
    { accountId: moved, name: 'Moved workspace' },
    { accountId: stranger, name: 'Stranger workspace' },
  ]);
  await db.insert(projects).values({ projectId: strangerProject, accountId: stranger, name: 'Stranger project', repoUrl: 'https://example.test/s.git' });
  await db.insert(projectSessions).values({ sessionId: strangerSession, projectId: strangerProject, accountId: stranger, branchName: 'main', status: 'stopped' });
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
  const logRow = (accountId: string, session: string | null, finalCost: string) => ({
    requestId: crypto.randomUUID(), accountId, projectId, sessionId: session,
    requestedModel: 'test-model', resolvedModel: 'test-model', provider: 'test',
    status: 200, ok: true, billingMode: 'credits' as const, finalCost,
  });
  await db.insert(gatewayRequestLogs).values([
    // Project-level spend from before the move with no session: the keeper
    // paid it, and no moved session carries it.
    logRow(keeper, null, '0.25'),
    // Another workspace's request that named this project.
    logRow(stranger, strangerSession, '7'),
  ]);
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
  await db.delete(projectSessions).where(inArray(projectSessions.sessionId, [sessionId, strangerSession]));
  await db.delete(projects).where(inArray(projects.projectId, [projectId, strangerProject]));
  await db.delete(accounts).where(inArray(accounts.accountId, [keeper, moved, stranger]));
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

  test('a project-scope read never takes a row billed to another account that is not one of its own sessions', async () => {
    // The stranger's row names the project, but its session is the stranger's.
    const spend = await listProjectGatewaySessionSpend({ accountId: moved, projectId, days: 1 });
    expect(spend.sessions.map((row) => row.session_id)).not.toContain(strangerSession);
    // The keeper's sessionless pre-move spend is not unassigned spend of the
    // moved workspace: the reconciliation reads only what this account paid.
    const page = await listSessionCosts({ accountId: moved, projectId, window, sort: 'recent', limit: 10, offset: 0 });
    expect([page.reconciliation.total_cost, page.reconciliation.request_count]).toEqual([0, 0]);
    // The stranger still sees its own row, and the keeper its sessionless spend.
    const own = await listSessionCosts({ accountId: stranger, projectId: strangerProject, window, sort: 'recent', limit: 10, offset: 0 });
    expect(own.sessions.map((row) => row.session_id)).toEqual([strangerSession]);
    const payer = await getCostSummary({ accountId: keeper, window });
    expect(payer.totals.llm_cost).toBe(1.75);
  });

  test("the payer keeps the money and labels the project 'Moved to another workspace', never by id or new name", async () => {
    const page = await listCostByProject({ accountId: keeper, window, sort: 'total_desc', limit: 10, offset: 0 });
    const row = page.projects.find((p) => p.project_id === projectId);
    expect(row).toMatchObject({ project_name: 'Moved to another workspace', moved: true, llm_cost: 1.75 });
    const summary = await getCostSummary({ accountId: keeper, window });
    expect(summary.totals.llm_cost).toBe(1.75);
  });

  test('the account-wide money view of the moved workspace does not take the payer’s spend', async () => {
    const summary = await getCostSummary({ accountId: moved, window });
    expect(summary.totals.llm_cost).toBe(0);
    expect(summary.totals.compute_cost).toBe(0);
  });
});
