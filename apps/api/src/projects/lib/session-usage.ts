/**
 * What a session and every session it started cost, in USD, from the gateway's
 * request ledger (`gateway_request_logs`).
 *
 * A sub-agent inside the session's sandbox calls models on the session's own
 * token, so its requests carry the session's id. A session that a session
 * started (`kortix sessions create` from inside it) is a separate row with
 * `parent_session_id` set, and its requests carry its own id. This rollup reads
 * both: the session's ledger, and the ledger of every descendant row.
 */
import { gatewayRequestLogs, projectSessions } from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { kortixBilledSpendSql, providerBilledSpendSql, totalSpendSql } from '../../shared/llm-spend';

/** Descendant levels read below the session. */
export const SESSION_USAGE_MAX_DEPTH = 10;
/** Descendant rows read below the session. */
export const SESSION_USAGE_MAX_DESCENDANTS = 500;

export interface SessionUsageTotals {
  /** Every dollar the model requests cost: `kortix_cost + provider_cost`. */
  cost: number;
  /** Debited from the Kortix wallet. */
  kortix_cost: number;
  /** Paid to the account's own provider key. */
  provider_cost: number;
  request_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
}

export interface SessionUsageNode extends SessionUsageTotals {
  session_id: string;
  /** Null for the session the read starts at. */
  parent_session_id: string | null;
  /** 0 for the session the read starts at. */
  depth: number;
  title: string | null;
  agent_name: string | null;
  status: string;
  created_at: string;
}

export interface SessionUsageTree {
  session_id: string;
  currency: 'USD';
  /** The sum over `sessions`. */
  total: SessionUsageTotals;
  /** The session first, then its descendants depth-first, oldest child first. */
  sessions: SessionUsageNode[];
  /** Descendants the caller may not open. Their rows and cost are not in `sessions` or `total`. */
  hidden_sessions: number;
  /** True when the read stopped at `SESSION_USAGE_MAX_DEPTH` or `SESSION_USAGE_MAX_DESCENDANTS`. */
  truncated: boolean;
}

type SessionRow = typeof projectSessions.$inferSelect;

const ZERO: SessionUsageTotals = {
  cost: 0,
  kortix_cost: 0,
  provider_cost: 0,
  request_count: 0,
  error_count: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_tokens: 0,
  cache_write_tokens: 0,
};

/** Money at the 10-decimal precision the ledger stores it at. */
const money = (value: number) => Number(value.toFixed(10));

function sessionTitle(metadata: unknown): string | null {
  const meta = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  return [meta.custom_name, meta.name].find((v): v is string => typeof v === 'string' && !!v.trim()) ?? null;
}

/**
 * The live descendants of a session in its project, nearest first. One
 * recursive read on `idx_project_sessions_parent`. The walk reads one level
 * past `SESSION_USAGE_MAX_DEPTH`, so the caller can tell that it stopped; a
 * parent cycle stops there too.
 */
async function descendantRows(root: Pick<SessionRow, 'sessionId' | 'projectId' | 'accountId'>) {
  const rows = await db.execute<{ session_id: string; parent_session_id: string; depth: number }>(sql`
    with recursive tree as (
      select s.session_id, s.parent_session_id, 1 as depth
        from ${projectSessions} s
       where s.parent_session_id = ${root.sessionId}
         and s.project_id = ${root.projectId}
         and s.account_id = ${root.accountId}
         and (s.metadata ? 'deletedAt') is not true
      union all
      select s.session_id, s.parent_session_id, tree.depth + 1
        from ${projectSessions} s
        join tree on s.parent_session_id = tree.session_id
       where tree.depth <= ${SESSION_USAGE_MAX_DEPTH}
         and s.project_id = ${root.projectId}
         and s.account_id = ${root.accountId}
         and (s.metadata ? 'deletedAt') is not true
    )
    select session_id, parent_session_id, min(depth)::int as depth
      from tree
     where session_id <> ${root.sessionId}
     group by session_id, parent_session_id
     order by depth
     limit ${SESSION_USAGE_MAX_DESCENDANTS + 1}
  `);
  return [...rows];
}

/** The ledger totals of each session id, in one grouped read on `idx_gateway_logs_session`. */
async function ledgerTotals(projectId: string, sessionIds: string[]): Promise<Map<string, SessionUsageTotals>> {
  const out = new Map<string, SessionUsageTotals>();
  if (sessionIds.length === 0) return out;
  const logs = gatewayRequestLogs;
  const rows = await db
    .select({
      sessionId: logs.sessionId,
      cost: totalSpendSql,
      kortixCost: kortixBilledSpendSql,
      providerCost: providerBilledSpendSql,
      requests: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where not ${logs.ok})::int`,
      input: sql<string>`coalesce(sum(${logs.inputTokens}), 0)`,
      output: sql<string>`coalesce(sum(${logs.outputTokens}), 0)`,
      cached: sql<string>`coalesce(sum(${logs.cachedTokens}), 0)`,
      cacheWrite: sql<string>`coalesce(sum(${logs.cacheWriteTokens}), 0)`,
    })
    .from(logs)
    .where(and(eq(logs.projectId, projectId), inArray(logs.sessionId, sessionIds)))
    .groupBy(logs.sessionId);
  for (const row of rows) {
    if (!row.sessionId) continue;
    out.set(row.sessionId, {
      cost: money(Number(row.cost)),
      kortix_cost: money(Number(row.kortixCost)),
      provider_cost: money(Number(row.providerCost)),
      request_count: row.requests,
      error_count: row.errors,
      input_tokens: Number(row.input),
      output_tokens: Number(row.output),
      cached_tokens: Number(row.cached),
      cache_write_tokens: Number(row.cacheWrite),
    });
  }
  return out;
}

export function sumSessionUsage(all: readonly SessionUsageTotals[]): SessionUsageTotals {
  const sum = { ...ZERO };
  for (const t of all) {
    for (const key of Object.keys(sum) as Array<keyof SessionUsageTotals>) sum[key] += t[key];
  }
  sum.cost = money(sum.cost);
  sum.kortix_cost = money(sum.kortix_cost);
  sum.provider_cost = money(sum.provider_cost);
  return sum;
}

/**
 * The usage of `root` and of every descendant the caller may open. `visible`
 * answers which descendant ids the caller may open (`loadVisibleSessionsForList`).
 * A hidden session hides its whole subtree: a child is listed only under a
 * parent the caller sees.
 */
export async function sessionUsageTree(
  root: SessionRow,
  visible: (sessionIds: string[]) => Promise<ReadonlyMap<string, SessionRow>>,
): Promise<SessionUsageTree> {
  const found = await descendantRows(root);
  const inDepth = found.filter((row) => row.depth <= SESSION_USAGE_MAX_DEPTH);
  const truncated = inDepth.length < found.length || inDepth.length > SESSION_USAGE_MAX_DESCENDANTS;
  const descendants = inDepth.slice(0, SESSION_USAGE_MAX_DESCENDANTS);
  const rows = descendants.length ? await visible(descendants.map((row) => row.session_id)) : new Map<string, SessionRow>();

  // Children by parent, oldest first, keeping only rows the caller sees.
  const children = new Map<string, SessionRow[]>();
  for (const { session_id, parent_session_id } of descendants) {
    const row = rows.get(session_id);
    if (!row) continue;
    const list = children.get(parent_session_id) ?? [];
    list.push(row);
    children.set(parent_session_id, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Depth-first from the root: a session whose parent is hidden is never reached.
  const ordered: Array<{ row: SessionRow; depth: number }> = [];
  const walk = (row: SessionRow, depth: number) => {
    ordered.push({ row, depth });
    for (const child of children.get(row.sessionId) ?? []) walk(child, depth + 1);
  };
  walk(root, 0);

  const totals = await ledgerTotals(root.projectId, ordered.map(({ row }) => row.sessionId));
  const sessions: SessionUsageNode[] = ordered.map(({ row, depth }) => ({
    session_id: row.sessionId,
    parent_session_id: depth === 0 ? null : row.parentSessionId,
    depth,
    title: sessionTitle(row.metadata),
    agent_name: row.agentName && row.agentName !== 'default' ? row.agentName : null,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    ...(totals.get(row.sessionId) ?? ZERO),
  }));

  return {
    session_id: root.sessionId,
    currency: 'USD',
    total: sumSessionUsage(sessions),
    sessions,
    hidden_sessions: descendants.length - (ordered.length - 1),
    truncated,
  };
}
