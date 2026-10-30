/**
 * The Inbox screen, as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * like `features/apps/apps-view.tsx`. `inbox-screen.tsx` owns the SDK.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import {
  FILTER_LABEL,
  type InboxFilter,
  type InboxRow,
  type InboxTone,
  badgeCount,
  filterRows,
  nextFilter,
} from './inbox-model.ts';
import { matchesInboxBinding } from './keys.ts';

export interface InboxViewProps {
  rows: InboxRow[];
  /** The server's unread count (over the newest 100), not the loaded rows'. */
  unreadCount: number;
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** Rendered in place of the list. The SDK error message, verbatim. */
  errorMessage: string | null;
  busyMessage?: string | null;
  initialFilter?: InboxFilter;
  /** Enter: the caller marks the row read and opens its target. */
  onOpen(row: InboxRow): void;
  onMarkRead(row: InboxRow): void;
  onMarkAllRead(): void;
  onOpenWeb(row: InboxRow): void;
  onRefresh(): void;
  onBack(): void;
}

const TONE_COLOR: Record<InboxTone, string> = {
  ok: theme.ok,
  idle: theme.faint,
  busy: theme.busy,
  bad: theme.danger,
};

/** The right column: `Question · Atlas · 3m`. */
export function rightText(row: InboxRow, now: number): string {
  return [row.kind, row.projectName, relativeAge(row.createdMs, now)].filter(Boolean).join(' · ');
}

/**
 * One row as plain text, cursor gutter excluded: `<unread> <glyph> <title>`
 * then the right column. The unread dot is the first column, so titles align
 * whether or not a row is unread.
 */
export function inboxRowText(row: InboxRow, now: number, width: number): string {
  const lead = `${row.read ? ' ' : GLYPH.running} ${row.glyph} `;
  return layoutRow(`${lead}${row.title}`, rightText(row, now), Math.max(width - 1, 0));
}

export function InboxView({
  rows,
  unreadCount,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  initialFilter = 'all',
  onOpen,
  onMarkRead,
  onMarkAllRead,
  onOpenWeb,
  onRefresh,
  onBack,
}: InboxViewProps) {
  const [filter, setFilter] = useState<InboxFilter>(initialFilter);
  // The id follows the row; the index keeps the cursor in place when the row
  // leaves the filtered list (a read row under `Unread`).
  const [cursor, setCursor] = useState<{ id: string | null; index: number }>({
    id: null,
    index: 0,
  });

  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const cursorIndex = useMemo(() => {
    const found = shown.findIndex((row) => row.id === cursor.id);
    if (found >= 0) return found;
    return Math.min(cursor.index, Math.max(shown.length - 1, 0));
  }, [shown, cursor]);
  const current = shown[cursorIndex] ?? null;
  const bodyWidth = Math.max(width - 1, 0);

  const moveTo = useCallback(
    (index: number) => {
      const at = Math.min(Math.max(index, 0), shown.length - 1);
      const row = shown[at];
      if (row) setCursor({ id: row.id, index: at });
    },
    [shown],
  );

  useKeyboard((key) => {
    if (!focused) return;
    if (matchesInboxBinding(key, 'inbox.back')) return onBack();
    if (matchesInboxBinding(key, 'inbox.down')) return moveTo(cursorIndex + 1);
    if (matchesInboxBinding(key, 'inbox.up')) return moveTo(cursorIndex - 1);
    if (matchesInboxBinding(key, 'inbox.first')) return moveTo(0);
    if (matchesInboxBinding(key, 'inbox.last')) return moveTo(shown.length - 1);
    if (matchesInboxBinding(key, 'inbox.refresh')) return onRefresh();
    if (matchesInboxBinding(key, 'inbox.readAll')) {
      if (unreadCount > 0) onMarkAllRead();
      return;
    }
    if (matchesInboxBinding(key, 'inbox.filter')) {
      setFilter((value) => nextFilter(value));
      setCursor({ id: null, index: 0 });
      return;
    }
    if (!current) return;
    if (matchesInboxBinding(key, 'inbox.open')) return onOpen(current);
    if (matchesInboxBinding(key, 'inbox.read')) {
      if (!current.read) onMarkRead(current);
      return;
    }
    if (matchesInboxBinding(key, 'inbox.web')) onOpenWeb(current);
  });

  // header + detail line + hints
  const room = Math.max(height - 3 - (busyMessage ? 1 : 0), 1);
  const start = windowStart(cursorIndex, shown.length, room);
  const visible = shown.slice(start, start + room);
  const header = `${FILTER_LABEL[filter]} · ${
    unreadCount > 0 ? `${badgeCount(unreadCount)} unread` : 'all read'
  }`;
  const hints = [
    'Enter open',
    'm read',
    unreadCount > 0 ? 'a read all' : null,
    'f filter',
    'o web',
    'Esc back',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <box flexDirection="column" width={width}>
      <text fg={theme.dim}>{header}</text>

      {visible.map((row) => {
        const isCursor = row.id === current?.id;
        const body = inboxRowText(row, now, width);
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : row.read ? theme.dim : theme.fg}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            {body.slice(0, 2)}
            <span fg={TONE_COLOR[row.tone]}>{body.slice(2, 3)}</span>
            {body.slice(3)}
          </text>
        );
      })}

      {loading && rows.length === 0 ? <Spinner label="loading inbox" /> : null}
      {!loading && !errorMessage && shown.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.fg}>
            {rows.length === 0 ? 'Nothing here yet' : 'Nothing in this filter'}
          </text>
          <text fg={theme.faint}>
            {rows.length === 0
              ? 'Questions, finished turns, shares and alerts land here.'
              : 'f changes the filter.'}
          </text>
        </box>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      <text fg={theme.dim}>
        {current?.body ? layoutRow(oneLine(current.body), '', bodyWidth) : ' '}
      </text>
      <text fg={theme.faint}>{hints}</text>
    </box>
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
