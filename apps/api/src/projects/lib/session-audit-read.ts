/**
 * The approval-projection half of `GET /:projectId/sessions/:sessionId/audit`
 * — every connector-gated action a session took, most-recent-first, capped at
 * `limit`.
 *
 * Extracted verbatim from `routes/project-audit.ts` so a second reader — the
 * session-open bundle's `audit` leg — answers from the SAME code rather than a
 * second copy of this reasoning. Two projections of one approval queue is
 * exactly how a client ends up holding two disagreeing answers to "what's
 * blocking this run".
 *
 * Deliberately excludes the `events`/`next_cursor` historical timeline: that
 * half needs its own audit-queue flush and its own cursor, and answers a
 * different question ("show me history") than this one ("what's pending
 * right now"). `GET .../audit` still owns both; this is only the part every
 * open session tab actually polls (`include_events=false`).
 *
 * No auth, visibility, or entitlement gate — the CALLER resolves `audited`
 * (the `auditAccess` entitlement check) and owns the visibility gate, exactly
 * as the route does before it reaches this function.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { connectorCalls, connectors } from '@kortix/db';
import { db } from '../../shared/db';
import { approvalPageUrl } from '../../setup-links/token';
import { lookupEmailsByUserIds } from '../lib/access';

/** One governed action, in the exact wire shape `GET .../audit` returns. */
export interface SessionAuditActionRow {
  execution_id: string;
  action: string;
  connector_id: string | null;
  connector: string | null;
  status: string;
  risk: string | null;
  acted_by: string | null;
  acted_by_email: string | null;
  resolved_by: string | null;
  resolved_by_email: string | null;
  result_summary: unknown | null;
  at: string;
  resolved_at: string | null;
  approval_url: string | null;
}

export interface SessionAuditActionsResult {
  session_id: string;
  agent: string | null;
  audit_access: boolean;
  count: number;
  actions: SessionAuditActionRow[];
}

export interface ReadSessionAuditActionsParams {
  projectId: string;
  sessionId: string;
  /** `visible.row.agentName` — passed through untouched into the response. */
  agentName: string | null;
  /** The caller's resolved `auditAccess` entitlement. `false` filters the
   *  query down to unresolved pending approvals only (never a 402 — see
   *  `routes/project-audit.ts` for why). */
  audited: boolean;
  limit: number;
}

/**
 * Read the connector-approval projection for one session.
 *
 * Same query, same batched email + connector-slug lookups, same
 * `approval_url` rule (unresolved pending rows only) as the standalone route.
 */
export async function readSessionAuditActions(
  params: ReadSessionAuditActionsParams,
): Promise<SessionAuditActionsResult> {
  const { projectId, sessionId, agentName, audited, limit } = params;

  const rows = await db
    .select({
      executionId: connectorCalls.executionId,
      connectorId: connectorCalls.connectorId,
      actionPath: connectorCalls.actionPath,
      actingUserId: connectorCalls.actingUserId,
      status: connectorCalls.status,
      risk: connectorCalls.risk,
      resultSummary: connectorCalls.resultSummary,
      approvedBy: connectorCalls.approvedBy,
      createdAt: connectorCalls.createdAt,
      resolvedAt: connectorCalls.resolvedAt,
    })
    .from(connectorCalls)
    .where(
      and(
        eq(connectorCalls.projectId, projectId),
        eq(connectorCalls.sessionId, sessionId),
        ...(audited
          ? []
          : [
              eq(connectorCalls.status, 'pending_approval'),
              isNull(connectorCalls.approvedBy),
              isNull(connectorCalls.resolvedAt),
            ]),
      ),
    )
    // Most-recent-first: when a busy session exceeds `limit`, keep the RECENT
    // actions (truncating oldest), not the other way round.
    .orderBy(desc(connectorCalls.createdAt))
    .limit(limit);

  // Resolve actor + approver emails in one batched lookup (managers see who).
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.actingUserId, r.approvedBy]).filter((v): v is string => !!v)),
  ];
  const emailByUser = userIds.length
    ? await lookupEmailsByUserIds(userIds)
    : new Map<string, string>();

  // Connector slugs in one batched lookup — the UI needs `<slug>.<action>` to
  // offer a "always run this" project-policy shortcut on a pending row.
  const connectorIds = [...new Set(rows.map((r) => r.connectorId).filter((v): v is string => !!v))];
  const slugByConnector = new Map<string, string>();
  if (connectorIds.length) {
    const conns = await db
      .select({ connectorId: connectors.connectorId, slug: connectors.slug })
      .from(connectors)
      .where(inArray(connectors.connectorId, connectorIds));
    for (const conn of conns) slugByConnector.set(conn.connectorId, conn.slug);
  }

  return {
    session_id: sessionId,
    agent: agentName,
    audit_access: audited,
    count: rows.length,
    actions: rows.map((r) => ({
      execution_id: r.executionId,
      action: r.actionPath,
      connector_id: r.connectorId,
      connector: r.connectorId ? (slugByConnector.get(r.connectorId) ?? null) : null,
      status: r.status,
      risk: r.risk,
      acted_by: r.actingUserId,
      acted_by_email: r.actingUserId ? (emailByUser.get(r.actingUserId) ?? null) : null,
      resolved_by: r.approvedBy,
      resolved_by_email: r.approvedBy ? (emailByUser.get(r.approvedBy) ?? null) : null,
      result_summary: r.resultSummary ?? null,
      at: r.createdAt.toISOString(),
      resolved_at: r.resolvedAt?.toISOString() ?? null,
      // For an UNRESOLVED row, the standalone page where a human reviews the
      // full (redacted) arguments and decides. Minted here so the in-session
      // notice can link straight to it without a second round trip. Only for
      // pending rows: a resolved row has nothing left to decide.
      approval_url:
        r.status === 'pending_approval' && !r.resolvedAt
          ? approvalPageUrl(projectId, r.executionId, sessionId)
          : null,
    })),
  };
}
