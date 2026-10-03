import type { AuditEvent } from '@kortix/sdk';
import { auditLabelForAction, auditLabelForHttpAction } from '@kortix/shared/audit-labels';
import { C, pad } from '../style.ts';

// The `kortix audit` table renderer — how a page of audit events becomes the
// WHEN / ACTOR / EVENT / ACTION / OUTCOME / RESOURCE table the terminal shows.
// Split from commands/audit.ts so the command file stays about routes, filters
// and pagination; this file is only about printing.

function shortTime(iso: string): string {
  // `2026-08-05T11:14:20.123Z` → `08-05 11:14:20`. The year is noise in a log
  // you are scanning; the seconds are not.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace('T', ' ');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** Longest ACTION cell before the table starts pushing RESOURCE off-screen.
 *  Rows written before audit labels carry raw HTTP lines, ~70 chars of
 *  mostly-identical path. Full values are always in `--json`. */
const ACTION_MAX = 40;
/** Longest EVENT cell: a catalog title is at most 7 words. */
const EVENT_MAX = 44;

/**
 * What a row's action reads as: its title in the shared audit catalog
 * (`gateway.key.revoke` → `Revoked LLM gateway key`), the title of the route a
 * pre-label `METHOD /route` row names, or the action itself.
 */
export function auditEventTitle(action: string): string {
  return (auditLabelForAction(action) ?? auditLabelForHttpAction(action))?.title ?? action;
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function outcomeCell(outcome: AuditEvent['outcome']): string {
  const label = outcome ?? '—';
  if (outcome === 'failure' || outcome === 'denied') return `${C.red}${pad(label, 8)}${C.reset}`;
  if (outcome === 'pending') return `${C.yellow}${pad(label, 8)}${C.reset}`;
  return `${C.faded}${pad(label, 8)}${C.reset}`;
}

function actorCell(event: AuditEvent): string {
  if (event.actor_type && event.actor_type !== 'human') return event.actor_type;
  return event.actor_user_id ? event.actor_user_id.slice(0, 8) : '—';
}

export function printEvents(events: AuditEvent[]): void {
  if (events.length === 0) {
    process.stdout.write(`\n  ${C.dim}No audit events match.${C.reset}\n\n`);
    return;
  }
  const eventW = Math.min(
    Math.max(...events.map((e) => auditEventTitle(e.action).length), 5),
    EVENT_MAX,
  );
  const actionW = Math.min(Math.max(...events.map((e) => e.action.length), 6), ACTION_MAX);
  const actorW = Math.max(...events.map((e) => actorCell(e).length), 5);
  process.stdout.write('\n');
  process.stdout.write(
    `  ${C.dim}${pad('WHEN (UTC)', 15)}   ${pad('ACTOR', actorW)}   ${pad('EVENT', eventW)}   ${pad('ACTION', actionW)}   ${pad('OUTCOME', 8)}   RESOURCE${C.reset}\n`,
  );
  for (const e of events) {
    const resource = e.resource_type
      ? `${e.resource_type}${e.resource_id ? ` ${C.faded}${e.resource_id.slice(0, 8)}${C.reset}` : ''}`
      : `${C.faded}—${C.reset}`;
    process.stdout.write(
      `  ${pad(shortTime(e.occurred_at), 15)}   ${pad(actorCell(e), actorW)}   ${pad(truncate(auditEventTitle(e.action), EVENT_MAX), eventW)}   ${C.faded}${pad(truncate(e.action, ACTION_MAX), actionW)}${C.reset}   ${outcomeCell(e.outcome)}   ${resource}\n`,
    );
  }
}
