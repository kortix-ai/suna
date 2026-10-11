import { connectorCalls, projectSecrets, projectSessions, sessionSandboxes, sessionTranscriptMessages, sessionTranscriptMirrors } from '@kortix/db';
import { and, count, eq, isNull, max } from 'drizzle-orm';
import { db } from '../../shared/db';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import { wakeLadderBudgetOf } from '../session-lifecycle/attended-wake-ladder';

export interface RuntimeControlState {
  known: true;
  /** The sandbox row's status, or null when the session has no sandbox row. */
  sandbox_status: string | null;
  external_id: string | null;
  provider: string | null;
  /** A wake is DRIVING this box right now (the fence's own verdict). */
  waking: boolean;
  /** Provider status observed by the wake loop, when it recorded one. */
  wake_provider_status: string | null;
  deadline_at: string | null;
  /** When the current wake started and last showed progress (ISO), or null. */
  wake_started_at: string | null;
  wake_progress_at: string | null;
  /** Why the box last stopped (`runtime_wake_failed`, `manual`, ...), or null. */
  stop_reason: string | null;
  /** The server wake ladder's spent budget for this episode (R5.2). */
  wake_ladder_budget: { retried: boolean; restarts: number; last_action_ms: number | null };
}

/** One indexed read: the sandbox row plus the wake fence's verdict on it. */
export async function readRuntimeControlState(sessionId: string): Promise<RuntimeControlState> {
  const [row] = await db
    .select({
      status: sessionSandboxes.status,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
      deadlineAt: sessionSandboxes.deadlineAt,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);

  if (!row) {
    return {
      known: true,
      sandbox_status: null,
      external_id: null,
      provider: null,
      waking: false,
      wake_provider_status: null,
      deadline_at: null,
      wake_started_at: null,
      wake_progress_at: null,
      stop_reason: null,
      wake_ladder_budget: { retried: false, restarts: 0, last_action_ms: null },
    };
  }
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    known: true,
    sandbox_status: row.status,
    external_id: row.externalId ?? null,
    provider: row.provider,
    waking: runtimeWakeInProgress(metadata),
    wake_provider_status:
      typeof metadata.runtimeWakeProviderStatus === 'string'
        ? metadata.runtimeWakeProviderStatus
        : null,
    deadline_at: row.deadlineAt ? row.deadlineAt.toISOString() : null,
    wake_started_at: stringOrNull(metadata.runtimeWakeStartedAt),
    wake_progress_at: stringOrNull(metadata.runtimeWakeProgressAt),
    stop_reason: stringOrNull(metadata.stopReason),
    wake_ladder_budget: (() => {
      const budget = wakeLadderBudgetOf(metadata);
      return { retried: budget.retried, restarts: budget.restarts, last_action_ms: budget.lastActionMs };
    })(),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export interface MirrorWatermark {
  known: true;
  /** `false` when nothing has ever been mirrored for this session. */
  present: boolean;
  captured_at: string | null;
  /** TRUE only when a capture PROVED it saw the session's first message. */
  head_complete: boolean;
  opencode_session_id: string | null;
  message_count: number;
  newest_message_at: string | null;
}

/**
 * How far the durable transcript copy has caught up.
 *
 * Two aggregate reads on the mirror's own index — never the message BODIES.
 * The watermark is what a client needs to decide whether to ask for an older
 * page; shipping the rows here would re-create the 7-19 MB transcript payloads
 * the mirror exists to prevent.
 */
export async function readMirrorWatermark(sessionId: string): Promise<MirrorWatermark> {
  const [mirror] = await db
    .select({
      capturedAt: sessionTranscriptMirrors.capturedAt,
      headComplete: sessionTranscriptMirrors.headComplete,
      opencodeSessionId: sessionTranscriptMirrors.runtimeSessionId,
    })
    .from(sessionTranscriptMirrors)
    .where(eq(sessionTranscriptMirrors.sessionId, sessionId))
    .limit(1);

  if (!mirror) {
    return {
      known: true,
      present: false,
      captured_at: null,
      head_complete: false,
      opencode_session_id: null,
      message_count: 0,
      newest_message_at: null,
    };
  }

  const [stats] = await db
    .select({
      messages: count(),
      newest: max(sessionTranscriptMessages.messageCreatedAt),
    })
    .from(sessionTranscriptMessages)
    .where(eq(sessionTranscriptMessages.sessionId, sessionId));

  return {
    known: true,
    present: true,
    captured_at: mirror.capturedAt ? mirror.capturedAt.toISOString() : null,
    head_complete: mirror.headComplete,
    opencode_session_id: mirror.opencodeSessionId ?? null,
    message_count: stats?.messages ?? 0,
    newest_message_at: stats?.newest ? new Date(stats.newest).toISOString() : null,
  };
}

export interface AuditWatermark {
  known: true;
  /** Unresolved connector-gated approvals awaiting a human decision. This is
   *  the number the sidebar nudge and the composer notice render. */
  pending: number;
  /** The newest connector-call CREATE instant — advances when a gated action
   *  appears, so a fresh row bumps the watermark even if nothing resolves. */
  latest_at: string | null;
  /** The newest RESOLVE instant — advances when an approval is approved/denied,
   *  so a resolution bumps the watermark even if the pending count is unchanged
   *  by a concurrent new row. */
  latest_resolved_at: string | null;
}

/**
 * The audit surface's change-detection watermark.
 *
 * Two aggregate reads on `connector_calls` (the connector-gated action log the
 * `GET .../audit` `actions` list is built from), never the rows. It captures
 * every state change the audit surface cares about: a new gated action
 * (`latest_at` moves), a resolution (`latest_resolved_at` moves and `pending`
 * falls), so `emit`'s fingerprint fires on each. The heavy row read stays where
 * it was — a human opens it; liveness only needs to know WHEN it changed.
 */
export async function readSessionAuditWatermark(
  sessionId: string,
  project: { projectId: string | null },
): Promise<AuditWatermark> {
  // No index on `connector_calls` leads with `session_id`, so a session-only
  // filter reads the whole all-tenant table every 5 s per watched session.
  // Filter on the project too, and never run the read without it.
  if (!project.projectId) {
    const [owner] = await db
      .select({ projectId: projectSessions.projectId })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    project.projectId = owner?.projectId ?? null;
  }
  const projectId = project.projectId;
  if (!projectId) throw new Error(`session ${sessionId} has no project; audit watermark skipped`);
  const [pendingRow] = await db
    .select({ pending: count() })
    .from(connectorCalls)
    .where(
      and(
        eq(connectorCalls.projectId, projectId),
        eq(connectorCalls.sessionId, sessionId),
        eq(connectorCalls.status, 'pending_approval'),
        isNull(connectorCalls.resolvedAt),
      ),
    );
  const [stamps] = await db
    .select({
      latest: max(connectorCalls.createdAt),
      latestResolved: max(connectorCalls.resolvedAt),
    })
    .from(connectorCalls)
    .where(and(eq(connectorCalls.projectId, projectId), eq(connectorCalls.sessionId, sessionId)));
  return {
    known: true,
    pending: pendingRow?.pending ?? 0,
    latest_at: stamps?.latest ? new Date(stamps.latest).toISOString() : null,
    latest_resolved_at: stamps?.latestResolved
      ? new Date(stamps.latestResolved).toISOString()
      : null,
  };
}

export interface SessionControlState {
  known: true;
  /** The title a client shows: the user's own name for the session, else the
   *  generated one, else null. */
  title: string | null;
  /**
   * A version of the project's secrets: their count and newest write. It
   * changes when a provider is connected or removed, so a client re-reads its
   * provider list on change instead of polling. Never a name or a value.
   */
  secrets_rev: string;
}

/**
 * The session's title and the project's secrets version (R5.2). A title write
 * NOTIFYs (`kortix_session_changed`); a secret write lands on the next pass.
 */
export async function readSessionControlState(sessionId: string): Promise<SessionControlState> {
  const [session] = await db
    .select({ sessionMetadata: projectSessions.metadata, sessionProjectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const metadata = (session?.sessionMetadata ?? {}) as Record<string, unknown>;
  const projectId = session?.sessionProjectId ?? null;
  const named = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  let secretsRev = '0:';
  if (projectId) {
    const [secrets] = await db
      .select({ secretCount: count(), secretsUpdatedAt: max(projectSecrets.updatedAt) })
      .from(projectSecrets)
      .where(eq(projectSecrets.projectId, projectId));
    const newest = secrets?.secretsUpdatedAt ? new Date(secrets.secretsUpdatedAt).toISOString() : '';
    secretsRev = `${secrets?.secretCount ?? 0}:${newest}`;
  }
  return {
    known: true,
    title: named(metadata.custom_name) ?? named(metadata.name),
    secrets_rev: secretsRev,
  };
}
