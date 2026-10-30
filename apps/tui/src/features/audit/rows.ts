/**
 * Pure view models for the Audit screen: the two SDK shapes (`AuditEvent`, the
 * ordered timeline; `SessionAuditAction`, a governed connector call) become one
 * `AuditRow`, and the filter picks rows by kind.
 *
 * The web panel shows pending actions first, then the event timeline. When the
 * timeline is empty it falls back to the non-pending actions
 * (`session-audit-panel.tsx`: `history`). This file mirrors both rules.
 */

import type { AuditEvent, SessionAuditAction } from '@kortix/sdk';

export const FILTERS = ['all', 'approvals', 'agent', 'person', 'failed'] as const;
export type AuditFilter = (typeof FILTERS)[number];

/** A pending call the viewer may or may not decide. */
export interface PendingInfo {
  executionId: string;
  /** True only when the API says this viewer may approve or deny. */
  canResolve: boolean;
  /** Who decides when the viewer cannot. */
  resolvers: string | null;
}

export interface AuditRow {
  id: string;
  atMs: number;
  /** ISO-8601 as the API sent it. */
  at: string;
  actor: string;
  /** `agent` · `person` · `system` · `service` — the actor class, for the filter. */
  actorKind: 'agent' | 'person' | 'system' | 'service';
  action: string;
  /** `success` · `failure` · `denied` · `pending` · `expired` · `ok` · `error` · `—`. */
  outcome: string;
  /** Label · value lines for the detail pane, in order. */
  fields: Array<[string, string]>;
  pending: PendingInfo | null;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function compact(fields: Array<[string, string | null | undefined]>): Array<[string, string]> {
  return fields.filter((entry): entry is [string, string] => Boolean(entry[1]));
}

export function isPendingAction(action: SessionAuditAction): boolean {
  return action.status === 'pending_approval' && !action.resolved_at;
}

const FAILED = new Set(['failure', 'denied', 'expired', 'error']);

export function isFailed(row: AuditRow): boolean {
  return FAILED.has(row.outcome);
}

const ACTOR_KIND: Record<string, AuditRow['actorKind']> = {
  human: 'person',
  agent: 'agent',
  service_account: 'service',
  system: 'system',
  anonymous: 'system',
};

export function eventRow(event: AuditEvent): AuditRow {
  const actorKind = ACTOR_KIND[event.actor_type ?? ''] ?? 'system';
  const actor =
    event.agent_name ||
    event.credential_name ||
    (actorKind === 'person' ? 'person' : (event.actor_type ?? 'unknown'));
  return {
    id: `event:${event.event_id}`,
    atMs: ms(event.occurred_at),
    at: event.occurred_at,
    actor,
    actorKind,
    action: event.action,
    outcome: event.outcome ?? '—',
    fields: compact([
      ['Time', event.occurred_at],
      ['Actor', `${actor}${event.actor_type ? ` (${event.actor_type})` : ''}`],
      ['Action', event.action],
      ['Outcome', event.outcome],
      ['Resource', event.resource_type ? `${event.resource_type} ${event.resource_id ?? ''}`.trim() : null],
      ['Source', event.authoritative_source ?? event.source],
      ['Credential', event.credential_kind],
      ['HTTP', event.http_status ? String(event.http_status) : null],
      ['Duration', event.duration_ms != null ? `${event.duration_ms} ms` : null],
      ['Error', event.error_message ?? event.error_code],
      ['Request', event.request_id],
    ]),
    pending: null,
  };
}

/** `args_preview` of a gated call, as one compact line. */
function argsPreview(action: SessionAuditAction): string | null {
  const preview = action.result_summary?.args_preview;
  if (preview == null) return null;
  return typeof preview === 'string' ? preview : JSON.stringify(preview);
}

export function actionRow(action: SessionAuditAction): AuditRow {
  const pending = isPendingAction(action);
  const name = `${action.connector ?? action.connector_id ?? 'connector'}.${action.action}`;
  const actor = action.acted_by_email || action.acted_by || 'agent';
  return {
    id: `action:${action.execution_id}`,
    atMs: ms(action.at),
    at: action.at,
    actor,
    actorKind: 'agent',
    action: name,
    outcome: pending ? 'pending' : action.status,
    fields: compact([
      ['Time', action.at],
      ['Actor', actor],
      ['Action', name],
      ['Outcome', pending ? 'pending approval' : action.status],
      ['Risk', action.risk],
      ['Arguments', argsPreview(action)],
      ['Decided by', action.resolved_by_email || action.resolved_by],
      ['Decided at', action.resolved_at],
      ['Execution', action.execution_id],
    ]),
    pending: pending
      ? {
          executionId: action.execution_id,
          canResolve: action.can_resolve === true,
          resolvers: action.resolvers ?? null,
        }
      : null,
  };
}

/**
 * Pending approvals first (oldest first: the longest wait on top), then the
 * timeline newest first. With no timeline, the settled actions stand in for it.
 */
export function buildRows(
  actions: readonly SessionAuditAction[],
  events: readonly AuditEvent[],
): AuditRow[] {
  const pending = actions
    .filter(isPendingAction)
    .map(actionRow)
    .sort((a, b) => a.atMs - b.atMs);
  const history =
    events.length > 0
      ? events.map(eventRow)
      : actions.filter((action) => !isPendingAction(action)).map(actionRow);
  history.sort((a, b) => (Number.isNaN(b.atMs) ? 0 : b.atMs) - (Number.isNaN(a.atMs) ? 0 : a.atMs));
  return [...pending, ...history];
}

export function filterRows(rows: readonly AuditRow[], filter: AuditFilter): AuditRow[] {
  switch (filter) {
    case 'approvals':
      return rows.filter((row) => row.pending !== null);
    case 'agent':
    case 'person':
      return rows.filter((row) => row.actorKind === filter);
    case 'failed':
      return rows.filter(isFailed);
    default:
      return [...rows];
  }
}
