#!/usr/bin/env bun
/**
 * Execute every Cost Explorer query against a REAL Postgres.
 *
 * Why this exists: the feature shipped proven only against a test double that
 * records SQL without running it, and a double cannot reject a statement. That
 * hid an ambiguous `last_at` subquery alias which made Postgres reject every
 * listSessionCosts call with 42702, while the unit suite stayed green. Rendering
 * SQL is not executing it. This script executes it.
 *
 * Executing without a rejection IS the assertion. Row contents do not matter
 * here: this checks that Postgres accepts and plans each statement, not that the
 * numbers are right — the unit suite owns the arithmetic.
 *
 *   cd apps/api && DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
 *     SUPABASE_URL="http://127.0.0.1:54321" INTERNAL_KORTIX_ENV="dev" \
 *     FRONTEND_URL="http://localhost:3000" bun scripts/verify-cost-queries.ts
 *
 * The extra env vars are only there because `config` validates the whole
 * environment at import time and a worktree's .env is dotenvx-encrypted. They are
 * throwaway local values — never put a real secret on this command line.
 *
 * The script anchors on the busiest real session it can find so the statements
 * run over actual rows. Against an empty database it falls back to placeholder
 * ids, and that run proves strictly less: each statement still has to parse and
 * plan, but getSessionCostRecord returns null at its very first query, so
 * everything downstream of it — both all-time total queries, the model usage
 * rollup, both ledger queries, and the owner lookup — never executes at all. The
 * output states which mode the run used, so a green result is never ambiguous
 * about which of the two it is.
 */
import { gatewayRequestLogs, projectSessions } from '@kortix/db';
import { desc, eq, sql } from 'drizzle-orm';
import { getCostSummary, listCostByWorkspace } from '../src/shared/cost-rollups';
import { db } from '../src/shared/db';
import {
  getSessionCostRecord,
  listWorkspaceGatewaySessionSpend,
  listSessionCosts,
} from '../src/shared/session-costs';

interface Anchor {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  ownerId: string;
  real: boolean;
}

// Ids that cannot match a row. Valid UUIDs, so Postgres still parses, plans and
// runs every statement — it just returns nothing.
const PLACEHOLDER: Anchor = {
  accountId: '00000000-0000-0000-0000-000000000001',
  workspaceId: '00000000-0000-0000-0000-0000000000ff',
  sessionId: '00000000-0000-0000-0000-0000000000fd',
  ownerId: '00000000-0000-0000-0000-0000000000fe',
  real: false,
};

// The session with the most gateway logs, so the detail queries have something
// to aggregate rather than trivially returning empty.
async function resolveAnchor(): Promise<Anchor> {
  const [busiest] = await db
    .select({
      accountId: projectSessions.accountId,
      workspaceId: projectSessions.workspaceId,
      sessionId: projectSessions.sessionId,
      ownerId: projectSessions.createdBy,
    })
    .from(projectSessions)
    .leftJoin(gatewayRequestLogs, eq(gatewayRequestLogs.sessionId, projectSessions.sessionId))
    .groupBy(
      projectSessions.accountId,
      projectSessions.workspaceId,
      projectSessions.sessionId,
      projectSessions.createdBy,
    )
    .orderBy(desc(sql`count(${gatewayRequestLogs.logId})`))
    .limit(1);

  if (!busiest) return PLACEHOLDER;
  return {
    accountId: busiest.accountId,
    workspaceId: busiest.workspaceId,
    sessionId: busiest.sessionId,
    ownerId: busiest.ownerId ?? PLACEHOLDER.ownerId,
    real: true,
  };
}

// Wide enough to contain any local data, and half-open like the production
// window so the bound comparisons are the ones the routes actually issue.
function costWindow() {
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const from = new Date(to.getTime() - 366 * 24 * 60 * 60 * 1000);
  return { from, to };
}

// The driver puts the entire failed statement in `message`; the Postgres error
// that explains the rejection is on `cause`. Report the latter — an ambiguous
// column is a one-line diagnosis buried under a ~2.7 KB SELECT.
function describeRejection(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.message) return `${cause.code ?? 'error'}: ${cause.message}`;
  return (error as Error).message?.split('\n')[0] ?? String(error);
}

// The query paths the /usage routes can issue, including every optional predicate
// they pass: project scope on the session list and the summary, owner scope on the
// list, project scope on the session detail, and session scope on the summary.
// (`listCostByWorkspace`'s sort is not among them — sortWorkspaceRows orders in memory,
// so the two sort cases below exercise one statement, not two.)
//
// Asserted rather than trusted: a case list that got trimmed or mis-filtered still
// prints "N executed / 0 rejected" and exits 0, so a green run would prove almost
// nothing — the exact failure this script exists to prevent. Same reasoning as
// KORTIX_MIN_TEST_FILES in test.sh.
const EXPECTED_CASE_COUNT = 12;

function buildCases(anchor: Anchor): Array<[string, () => Promise<unknown>]> {
  const { accountId, workspaceId, sessionId, ownerId } = anchor;
  const window = costWindow();
  const page = { window, limit: 25, offset: 0 };

  return [
    [
      'listSessionCosts sort=total_desc',
      () => listSessionCosts({ accountId, sort: 'total_desc', ...page }),
    ],
    [
      'listSessionCosts sort=total_asc',
      () => listSessionCosts({ accountId, sort: 'total_asc', ...page }),
    ],
    [
      'listSessionCosts sort=recent',
      () => listSessionCosts({ accountId, sort: 'recent', ...page }),
    ],
    [
      'listSessionCosts + workspaceId + ownerId',
      () => listSessionCosts({ accountId, workspaceId, ownerId, sort: 'total_desc', ...page }),
    ],
    [
      'listCostByWorkspace sort=total_desc',
      () => listCostByWorkspace({ accountId, sort: 'total_desc', ...page }),
    ],
    [
      'listCostByWorkspace sort=name_asc',
      () => listCostByWorkspace({ accountId, sort: 'name_asc', ...page }),
    ],
    ['getCostSummary account-wide', () => getCostSummary({ accountId, window })],
    ['getCostSummary project-scoped', () => getCostSummary({ accountId, workspaceId, window })],
    // GET /usage/cost-summary passes session_id through, and it adds a predicate to
    // both aggregates, so it is a distinct statement from the two above.
    ['getCostSummary session-scoped', () => getCostSummary({ accountId, sessionId, window })],
    ['getSessionCostRecord', () => getSessionCostRecord({ accountId, sessionId })],
    // GET /usage/session-costs/:sessionId passes project_id through, which adds a
    // predicate the unscoped case above never exercises.
    [
      'getSessionCostRecord project-scoped',
      () => getSessionCostRecord({ accountId, workspaceId, sessionId }),
    ],
    [
      'listWorkspaceGatewaySessionSpend',
      () => listWorkspaceGatewaySessionSpend({ accountId, workspaceId, days: 30 }),
    ],
  ];
}

const anchor = await resolveAnchor();
console.log(
  anchor.real
    ? `anchor: real session ${anchor.sessionId} (project ${anchor.workspaceId})`
    : 'anchor: placeholder ids — database has no sessions, detail queries will short-circuit',
);

const cases = buildCases(anchor);
if (cases.length !== EXPECTED_CASE_COUNT) {
  // Exit 2, not 1: the script itself is wrong, which is a different failure from
  // Postgres rejecting a query, and a caller should be able to tell them apart.
  console.error(
    `case list holds ${cases.length}, expected ${EXPECTED_CASE_COUNT} — refusing to report a partial run as green`,
  );
  process.exit(2);
}

let rejected = 0;
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`PASS  ${name}`);
  } catch (error) {
    rejected += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${describeRejection(error)}`);
  }
}

console.log(`\n${cases.length - rejected} executed / ${rejected} rejected`);
process.exit(rejected > 0 ? 1 : 0);
