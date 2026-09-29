/**
 * Resolving a policy-gated connector call — the one implementation behind every
 * surface a human decides on (the web cards via POST /approvals/:executionId,
 * and the Slack approval card). Authorization is the CALLER's job: each surface
 * proves a human with `mayResolveApproval` / `humanMayResolveApproval` first.
 */
import { connectorCalls, projectSessions, sessionLifecycleCommands } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';
import { approvalPreviewReviewable } from '../../connectors/args-preview';
import { approvalResolvedAuditEvent } from '../../connectors/call-audit';
import { recordAuditEvent } from '../../shared/audit';
import { db } from '../../shared/db';
import { buildContinueSessionCommandValues, drainSessionLifecycleQueue } from '../session-lifecycle';

export type ApprovalDecision = 'approve' | 'deny';

export interface PendingApprovalRow {
  executionId: string;
  sessionId: string | null;
  actingUserId: string | null;
  connectorId: string | null;
  actionPath: string;
  status: string;
  approvedBy: string | null;
  resolvedAt: Date | null;
  resultSummary: unknown;
}

export async function loadApprovalRow(
  projectId: string,
  executionId: string,
): Promise<PendingApprovalRow | null> {
  const [row] = await db
    .select({
      executionId: connectorCalls.executionId,
      sessionId: connectorCalls.sessionId,
      actingUserId: connectorCalls.actingUserId,
      connectorId: connectorCalls.connectorId,
      actionPath: connectorCalls.actionPath,
      status: connectorCalls.status,
      approvedBy: connectorCalls.approvedBy,
      resolvedAt: connectorCalls.resolvedAt,
      resultSummary: connectorCalls.resultSummary,
    })
    .from(connectorCalls)
    .where(and(eq(connectorCalls.executionId, executionId), eq(connectorCalls.projectId, projectId)))
    .limit(1);
  return row ?? null;
}

export function isPendingApproval(row: PendingApprovalRow): boolean {
  return row.status === 'pending_approval' && !row.approvedBy && !row.resolvedAt;
}

/** `created_by` + origin of the session a gated call belongs to — the inputs
 *  of the launcher half of the authority rule. */
export async function approvalTargetSession(
  projectId: string,
  row: PendingApprovalRow,
): Promise<{ createdBy: string | null; origin: string | null }> {
  if (!row.sessionId) return { createdBy: row.actingUserId, origin: 'user' };
  const [session] = await db
    .select({ createdBy: projectSessions.createdBy, origin: projectSessions.origin })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, row.sessionId), eq(projectSessions.projectId, projectId)))
    .limit(1);
  return { createdBy: session?.createdBy ?? null, origin: session?.origin ?? null };
}

/** The prompt that tells the agent what the human decided — and what they said. */
export function approvalResumeText(actionPath: string, decision: ApprovalDecision, note: string): string {
  if (decision === 'approve') {
    return `Your pending approval to run ${actionPath} was approved — continue.${note ? `\n\nMessage from the approver:\n${note}` : ''}`;
  }
  return note
    ? `Your request to run ${actionPath} was denied. Message from the approver:\n${note}`
    : `Your request to run ${actionPath} was denied — continue without it.`;
}

export function normalizeApprovalNote(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 4_000) : '';
}

export type DecideOutcome = 'resolved' | 'already_resolved' | 'preview_unavailable';

/**
 * Apply one human decision. `resume: 'queue'` enqueues the durable
 * `system:approval-resume` continuation in the same transaction as the
 * resolve; `'caller'` leaves resuming to the surface (the Slack card resumes
 * through a Slack-native turn so the thread shows the agent working).
 */
export async function decideConnectorApproval(input: {
  projectId: string;
  accountId: string;
  row: PendingApprovalRow;
  decision: ApprovalDecision;
  note: string;
  actorUserId: string;
  auditSource: string;
  resume: 'queue' | 'caller';
}): Promise<DecideOutcome> {
  const { projectId, row, decision, note } = input;
  const existingDetail =
    typeof row.resultSummary === 'object' && row.resultSummary
      ? (row.resultSummary as Record<string, unknown>)
      : {};
  // Blind approval stays impossible — but only when the row genuinely shows
  // NOTHING. A shortened preview is still reviewable; see
  // `approvalPreviewReviewable`.
  if (decision === 'approve' && !approvalPreviewReviewable(existingDetail)) {
    return 'preview_unavailable';
  }

  const detail = {
    ...existingDetail,
    decision,
    decided_by: input.actorUserId,
    ...(note ? { decision_note: note } : {}),
  };
  const callbackValues =
    row.sessionId && input.resume === 'queue'
      ? buildContinueSessionCommandValues({
          source: 'system:approval-resume',
          projectId,
          accountId: input.accountId,
          sessionId: row.sessionId,
          actorUserId: input.actorUserId,
          text: approvalResumeText(row.actionPath, decision, note),
          executionId: row.executionId,
          availableAt: new Date(),
          idempotencyKey: `approval-resume:${row.executionId}`,
        })
      : null;
  // Atomic resolve — guard the UPDATE on the still-pending state so two
  // concurrent resolvers can't both win (TOCTOU): approve clears the gate to
  // the terminal `ok` (the real retried call re-audits as its own row), deny
  // flips it to `denied`. Both stamp approvedBy (= who resolved) + resolvedAt,
  // so the row leaves the pending inbox. A lost race matches 0 rows.
  const resolved = await db.transaction(async (tx) => {
    const updated = await tx
      .update(connectorCalls)
      .set({
        status: decision === 'approve' ? 'ok' : 'denied',
        approvedBy: input.actorUserId,
        resolvedAt: new Date(),
        resultSummary: detail,
      })
      .where(
        and(
          eq(connectorCalls.executionId, row.executionId),
          eq(connectorCalls.projectId, projectId),
          eq(connectorCalls.status, 'pending_approval'),
          isNull(connectorCalls.approvedBy),
          isNull(connectorCalls.resolvedAt),
        ),
      )
      .returning({ id: connectorCalls.executionId });
    if (updated.length > 0 && callbackValues) {
      await tx
        .insert(sessionLifecycleCommands)
        .values(callbackValues)
        .onConflictDoNothing({ target: sessionLifecycleCommands.idempotencyKey });
    }
    return updated;
  });
  if (resolved.length === 0) return 'already_resolved';

  try {
    await recordAuditEvent(
      approvalResolvedAuditEvent({
        accountId: input.accountId,
        projectId,
        sessionId: row.sessionId,
        executionId: row.executionId,
        actorUserId: input.actorUserId,
        actionPath: row.actionPath,
        connectorId: row.connectorId,
        decision,
        source: input.auditSource,
      }),
    );
  } catch (error) {
    console.error('[approvals] failed to record central audit event', error);
  }

  // Decision callback. The connector HTTP call returned the approval URL and
  // ended; the durable command above is the callback, and this drain is the
  // best-effort immediate delivery. The next exact call claims the approved
  // request digest once. A changed payload creates a new approval instead.
  if (callbackValues) {
    void drainSessionLifecycleQueue({
      limit: 1,
      idempotencyKey: `approval-resume:${row.executionId}`,
    }).catch(() => {});
  }

  // A card posted in a chat thread must not keep offering buttons for a call
  // decided elsewhere. Lazy import: channels depend on projects, not back.
  void import('../../channels/approval-card-relay')
    .then((relay) =>
      relay.markApprovalCardDecided({
        projectId,
        resultSummary: existingDetail,
        actionPath: row.actionPath,
        decision,
        note,
        actorUserId: input.actorUserId,
      }),
    )
    .catch((error) => console.warn('[approvals] approval card update failed', error));

  return 'resolved';
}
