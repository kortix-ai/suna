/**
 * The Audit screen, as pixels and keys only.
 *
 * `rows` arrive unfiltered; the view owns the filter (`f`) and applies it with
 * `filterRows`. Everything done leaves as a callback; `audit-screen.tsx` owns
 * the SDK. Modes: `browse`, `details`, `confirm` (approve or deny).
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { matchesAuditBinding } from './keys.ts';
import { FILTERS, type AuditFilter, type AuditRow, filterRows, isFailed } from './rows.ts';

export interface AuditViewProps {
  rows: AuditRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  errorMessage: string | null;
  /** One dim line under the list: `approving…`. */
  busyMessage?: string | null;
  /** One dim line under the list: why the history is short. */
  notice?: string | null;
  /** True when older events exist. `m` loads them. */
  hasMore?: boolean;
  onDecide(row: AuditRow, decision: 'approve' | 'deny'): void;
  onLoadMore(): void;
  onRefresh(): void;
  /** Esc with nothing open. */
  onBack(): void;
}

const LABEL_WIDTH = 12;
const ACTOR_WIDTH = 14;

function toneOf(row: AuditRow): string {
  if (row.pending) return theme.busy;
  if (isFailed(row)) return theme.danger;
  return theme.faint;
}

function glyphOf(row: AuditRow): string {
  if (row.pending) return GLYPH.running;
  if (isFailed(row)) return GLYPH.failed;
  return GLYPH.child;
}

/**
 * One list row as plain text, cursor gutter excluded:
 * `<glyph> <age> <actor> <action>   <outcome>`.
 */
export function auditRowText(row: AuditRow, now: number, width: number): string {
  const age = (relativeAge(row.atMs, now) || '—').padEnd(4, ' ');
  const actor = row.actor.length > ACTOR_WIDTH ? `${row.actor.slice(0, ACTOR_WIDTH - 1)}…` : row.actor;
  return layoutRow(
    `${glyphOf(row)} ${age} ${actor.padEnd(ACTOR_WIDTH, ' ')} ${row.action}`,
    row.outcome,
    Math.max(width - 1, 0),
  );
}

export function AuditView({
  rows,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  notice = null,
  hasMore = false,
  onDecide,
  onLoadMore,
  onRefresh,
  onBack,
}: AuditViewProps) {
  const [mode, setMode] = useState<'browse' | 'details' | 'confirm'>('browse');
  const [filter, setFilter] = useState<AuditFilter>('all');
  const [decision, setDecision] = useState<'approve' | 'deny'>('approve');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.id ?? null);
  const [note, setNote] = useState<string | null>(null);

  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const cursorIndex = useMemo(() => {
    const found = shown.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [shown, cursorId]);
  const current = shown[cursorIndex] ?? null;

  const moveTo = useCallback(
    (index: number) => {
      const row = shown[Math.min(Math.max(index, 0), shown.length - 1)];
      if (row) setCursorId(row.id);
      setNote(null);
    },
    [shown],
  );

  const startDecision = useCallback(
    (next: 'approve' | 'deny') => {
      if (!current?.pending) return setNote('Only a pending action can be decided.');
      if (!current.pending.canResolve) {
        return setNote(
          current.pending.resolvers === 'managers'
            ? 'Only project managers can decide this action.'
            : 'Only project managers and the session launcher can decide this action.',
        );
      }
      setDecision(next);
      setMode('confirm');
    },
    [current],
  );

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'confirm') {
      if (matchesAuditBinding(key, 'back') || matchesAuditBinding(key, 'cancel')) {
        setMode('browse');
        return;
      }
      if (matchesAuditBinding(key, 'confirm')) {
        const target = current;
        setMode('browse');
        if (target) onDecide(target, decision);
      }
      return;
    }

    if (mode === 'details') {
      if (matchesAuditBinding(key, 'back')) return setMode('browse');
      if (matchesAuditBinding(key, 'approve')) return startDecision('approve');
      if (matchesAuditBinding(key, 'deny')) startDecision('deny');
      return;
    }

    if (matchesAuditBinding(key, 'back')) return onBack();
    if (matchesAuditBinding(key, 'down')) return moveTo(cursorIndex + 1);
    if (matchesAuditBinding(key, 'up')) return moveTo(cursorIndex - 1);
    if (matchesAuditBinding(key, 'first')) return moveTo(0);
    if (matchesAuditBinding(key, 'last')) return moveTo(shown.length - 1);
    if (matchesAuditBinding(key, 'refresh')) return onRefresh();
    if (matchesAuditBinding(key, 'more')) return hasMore ? onLoadMore() : undefined;
    if (matchesAuditBinding(key, 'filter')) {
      setFilter((value) => FILTERS[(FILTERS.indexOf(value) + 1) % FILTERS.length] ?? 'all');
      setNote(null);
      return;
    }
    if (matchesAuditBinding(key, 'details')) return current ? setMode('details') : undefined;
    if (matchesAuditBinding(key, 'approve')) return startDecision('approve');
    if (matchesAuditBinding(key, 'deny')) startDecision('deny');
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (mode === 'details' && current) {
    const valueRoom = Math.max(bodyWidth - LABEL_WIDTH, 8);
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>{layoutRow(current.action, current.outcome, bodyWidth)}</text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {current.fields.map(([label, value]) => (
          <text key={label} fg={theme.fg}>
            <span fg={theme.faint}>{label.padEnd(LABEL_WIDTH, ' ')}</span>
            {value.length > valueRoom ? `${value.slice(0, valueRoom - 1)}…` : value}
          </text>
        ))}
        {note ? <text fg={theme.busy}>{note}</text> : null}
        <text fg={theme.faint}>
          {current.pending ? 'a approve · x deny · Esc back' : 'Esc back'}
        </text>
      </box>
    );
  }

  const confirming = mode === 'confirm';
  const extra = (confirming ? 3 : 0) + (busyMessage ? 1 : 0) + (notice ? 1 : 0) + (note ? 1 : 0);
  const rowsAvailable = Math.max(height - extra - 2, 1);
  const start = windowStart(cursorIndex, shown.length, rowsAvailable);
  const visible = shown.slice(start, start + rowsAvailable);
  const pendingCount = rows.filter((row) => row.pending).length;
  const hints = [
    'Enter detail',
    'f filter',
    pendingCount > 0 ? 'a approve · x deny' : null,
    hasMore ? 'm older' : null,
    'r refresh',
    'Esc back',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.dim}>
        {layoutRow(
          `Audit · ${filter}`,
          `${shown.length} events${pendingCount > 0 ? ` · ${pendingCount} pending` : ''}`,
          bodyWidth,
        )}
      </text>
      {confirming && current ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>{decision === 'approve' ? 'Approve action' : 'Deny action'}</text>
          <text fg={theme.fg}>{layoutRow(current.action, current.actor, bodyWidth)}</text>
          <text fg={theme.faint}>y confirm · n or Esc cancel</text>
        </box>
      ) : null}

      {visible.map((row) => {
        const isCursor = row.id === current?.id;
        const body = auditRowText(row, now, width);
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            <span fg={toneOf(row)}>{body.slice(0, 2)}</span>
            {body.slice(2)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading audit" /> : null}
      {!loading && !errorMessage && shown.length === 0 ? (
        <text fg={theme.faint}>
          {rows.length > 0 ? `No ${filter} events. Press f.` : 'No audit events in this session yet.'}
        </text>
      ) : null}
      {errorMessage ? <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text> : null}
      {note ? <text fg={theme.busy}>{note}</text> : null}
      {notice ? <text fg={theme.faint}>{notice}</text> : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      <text fg={theme.faint}>{layoutRow(hints, '', bodyWidth)}</text>
    </box>
  );
}
