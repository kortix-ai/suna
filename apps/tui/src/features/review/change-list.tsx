/**
 * The change-request list, as pixels only.
 *
 * One row per change request plus a detail block for the row under the cursor.
 * A change request's own meta (base ref, origin session, head sha) does not fit
 * beside a title at 60 columns, and a second dim line per row would halve how
 * many rows a terminal shows — so the meta follows the cursor instead.
 *
 * `review-screen.tsx` owns the data and the keys; this file draws what it is
 * handed and nothing else.
 */

import type { ChangeRequest } from '@kortix/sdk';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';

/** One list row, flattened from the SDK's `ChangeRequest`. */
export interface ChangeRow {
  crId: string;
  number: number;
  title: string;
  status: ChangeRequest['status'];
  baseRef: string;
  headRef: string;
  /** `created_at` in epoch ms, for the age column. */
  createdAtMs: number;
  /** The session that opened it, or null. `o` needs this. */
  originSessionId: string | null;
  headCommitSha: string | null;
}

export function toChangeRow(cr: ChangeRequest): ChangeRow {
  return {
    crId: cr.cr_id,
    number: cr.number,
    title: cr.title?.trim() || `Change request #${cr.number}`,
    status: cr.status,
    baseRef: cr.base_ref,
    headRef: cr.head_ref,
    createdAtMs: Date.parse(cr.created_at),
    originSessionId: cr.origin_session_id,
    headCommitSha: cr.head_commit_sha,
  };
}

/** `●` open, `✓` merged, `○` closed — one column, so rows never reflow. */
export function statusGlyph(status: ChangeRequest['status']): string {
  if (status === 'merged') return '✓';
  if (status === 'closed') return GLYPH.stopped;
  return GLYPH.running;
}

export function statusColor(status: ChangeRequest['status']): string {
  if (status === 'merged') return theme.ok;
  if (status === 'closed') return theme.faint;
  return theme.busy;
}

export interface ChangeListProps {
  rows: ChangeRow[];
  selectedId: string | null;
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** The SDK error message, verbatim. */
  errorMessage: string | null;
  /** One dim line under the list: `merging…`, `closing…`. */
  busyMessage?: string | null;
}

export function ChangeList({
  rows,
  selectedId,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
}: ChangeListProps) {
  const bodyWidth = Math.max(width - 1, 0);
  const index = Math.max(
    rows.findIndex((row) => row.crId === selectedId),
    0,
  );
  const current = rows[index];
  // Header, the detail block (3 rows), the busy line, the hint line.
  const detailRows = current ? 3 : 0;
  const listRows = Math.max(height - 2 - detailRows - (busyMessage ? 1 : 0), 1);
  const start = windowStart(index, rows.length, listRows);
  const visible = rows.slice(start, start + listRows);

  return (
    <box flexDirection="column" width={width}>
      <text fg={focused ? theme.fg : theme.dim}>
        {layoutRow('Change requests', rows.length ? String(rows.length) : '', bodyWidth)}
      </text>

      {visible.map((row) => {
        const isCursor = row.crId === current?.crId;
        const label = `${statusGlyph(row.status)} #${row.number} ${row.title}`;
        const body = layoutRow(label, relativeAge(row.createdAtMs, now), bodyWidth);
        return (
          <text
            key={row.crId}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            <span fg={statusColor(row.status)}>{body.slice(0, 1)}</span>
            {body.slice(1)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading change requests" /> : null}
      {!loading && !errorMessage && rows.length === 0 ? (
        <text fg={theme.faint}>No change requests.</text>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}

      {current ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
          <text fg={theme.dim}>
            {layoutRow(`${current.status} · into ${current.baseRef}`, '', bodyWidth)}
          </text>
          <text fg={theme.faint}>
            {layoutRow(
              `${current.headCommitSha ? `${current.headCommitSha.slice(0, 7)} · ` : ''}${
                current.originSessionId
                  ? `session ${current.originSessionId.slice(0, 8)}`
                  : 'no origin session'
              }`,
              '',
              bodyWidth,
            )}
          </text>
        </box>
      ) : null}

      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
    </box>
  );
}
