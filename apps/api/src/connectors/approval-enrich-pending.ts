/**
 * Lazy approval enrichment for pending rows written before their action had an
 * enricher (approval-enrichers.ts). A by-id read of such a row runs the
 * enricher once and stores `resolved_preview` + `resolved_digest` (or
 * `resolved_error`) in its `result_summary`, so the consume-time content
 * binding covers it like a row enriched at hold time.
 */
import { connectorCalls, connectors } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { isPlainRecord } from './args-preview';
import { approvalNotExpired, isApprovalExpired } from './approval-expiry';
import {
  APPROVAL_ENRICHERS,
  type ApprovalEnricher,
  type ApprovalEnricherContext,
  enricherKey,
  resolveApprovalPreview,
} from './approval-enrichers';
import { makeDbGatewayDeps, toGatewayConnector } from './db-deps-gateway';
import { resolveActiveConnectorConnection } from './db-deps-rows';
import type { ConnectorPrincipal } from './router-contract';

type CallRow = typeof connectorCalls.$inferSelect;
type PendingCall = Pick<
  CallRow,
  | 'executionId'
  | 'accountId'
  | 'projectId'
  | 'connectorId'
  | 'connectionId'
  | 'actionPath'
  | 'sessionId'
  | 'actingUserId'
  | 'status'
  | 'expiresAt'
  | 'resultSummary'
>;

/** The enricher input the held call had: its connector, connection, binding and args. */
async function enricherContextFor(
  call: PendingCall,
): Promise<{ key: string; ctx: ApprovalEnricherContext } | null> {
  if (!call.connectorId || !call.actingUserId) return null;
  const [row] = await db.select().from(connectors).where(eq(connectors.connectorId, call.connectorId)).limit(1);
  if (!row) return null;
  // `action_path` is `<slug the agent called>.<connector-relative path>`.
  const actionPath = call.actionPath.slice(call.actionPath.indexOf('.') + 1);
  const principal: ConnectorPrincipal = {
    userId: call.actingUserId,
    accountId: call.accountId,
    projectId: call.projectId,
    sessionId: call.sessionId,
    subject: { userId: call.actingUserId, groupIds: [] },
    requestedConnectorAccount: call.connectionId,
  };
  const connection = await resolveActiveConnectorConnection(principal, row);
  if (!connection) return null;
  const deps = makeDbGatewayDeps(principal);
  const action = await deps.loadAction(row.connectorId, actionPath, row.providerType);
  if (!action) return null;
  const connector = toGatewayConnector(row, connection);
  const summary = isPlainRecord(call.resultSummary) ? call.resultSummary : {};
  const args = isPlainRecord(summary.args_preview) ? summary.args_preview : {};
  return {
    key: enricherKey(connector, action.binding, actionPath),
    ctx: {
      deps,
      connector,
      binding: action.binding,
      args,
      input: {
        projectId: call.projectId,
        accountId: call.accountId,
        subject: principal.subject,
        sessionId: call.sessionId,
        connectorSlug: row.slug,
        actionPath,
        args,
      },
    },
  };
}

/**
 * The `result_summary` to serve for a pending call read by id. Runs the
 * enricher at most once per row: only for a pending, unexpired call whose
 * action has an enricher and whose summary has neither `resolved_preview` nor
 * `resolved_error`. The UPDATE re-checks both, so a racing read writes nothing.
 * Callers gate this on the viewer being allowed to see the preview.
 */
export async function enrichPendingCallOnce(
  call: PendingCall,
  opts: {
    enrichers?: Readonly<Record<string, ApprovalEnricher>>;
    contextFor?: typeof enricherContextFor;
  } = {},
): Promise<CallRow['resultSummary']> {
  const summary = isPlainRecord(call.resultSummary) ? call.resultSummary : {};
  if (
    call.status !== 'pending_approval' ||
    isApprovalExpired(call) ||
    'resolved_preview' in summary ||
    'resolved_error' in summary
  ) {
    return call.resultSummary;
  }
  const found = await (opts.contextFor ?? enricherContextFor)(call).catch(() => null);
  const enricher = found && (opts.enrichers ?? APPROVAL_ENRICHERS)[found.key];
  if (!found || !enricher) return call.resultSummary;
  const resolved = await resolveApprovalPreview(enricher, found.ctx);
  const next = { ...summary, ...resolved };
  // A failed write never fails the read: the reviewer still sees the content,
  // and the next read tries again.
  await db
    .update(connectorCalls)
    .set({ resultSummary: next })
    .where(
      and(
        eq(connectorCalls.executionId, call.executionId),
        eq(connectorCalls.status, 'pending_approval'),
        approvalNotExpired,
        sql`not (coalesce(${connectorCalls.resultSummary}, '{}'::jsonb) ?| array['resolved_preview', 'resolved_error'])`,
      ),
    )
    .catch((error: unknown) => {
      logger.warn('[approvals] could not store the loaded approval content', {
        executionId: call.executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return next;
}
