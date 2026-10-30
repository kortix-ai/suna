/**
 * The Spaces screen, as pixels and keys only.
 *
 * A space is a channel or the caller's DM with one agent. Two levels: the
 * space list, then the threads (sessions) filed in the open space. Everything
 * drawn arrives as a prop and everything done leaves as a callback;
 * `spaces-screen.tsx` owns the SDK.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { matchesSpacesBinding } from './keys.ts';

export interface SpaceRow {
  id: string;
  kind: 'channel' | 'dm';
  /** `# general` for a channel, `@ agent` for a DM. */
  label: string;
  description: string;
  /** `private` for a private channel, else empty. */
  badge: string;
  updatedMs: number;
}

export interface ThreadRow {
  /** The session id. */
  id: string;
  title: string;
  /** Messages after the first prompt. `null` when the API sent none. */
  replies: number | null;
  /** `running` · `stopped` · `failed` … the session status word. */
  status: string;
  updatedMs: number;
}

export interface SpacesViewProps {
  spaces: SpaceRow[];
  /** The threads of the open space. Ignored while no space is open. */
  threads: ThreadRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  threadsLoading: boolean;
  errorMessage: string | null;
  threadsError: string | null;
  /** One dim line under the list: `starting a thread…`. */
  busyMessage?: string | null;
  /** `null` closes the threads. The host fetches the threads for a non-null id. */
  onOpenSpace(spaceId: string | null): void;
  onOpenThread(sessionId: string): void;
  onNewThread(space: SpaceRow): void;
  onOpenBrowser(space: SpaceRow): void;
  onRefresh(): void;
  /** Esc with nothing open. */
  onBack(): void;
}

/** The right column of a thread row. */
export function threadRightText(thread: ThreadRow, now: number): string {
  const age = relativeAge(thread.updatedMs, now);
  const replies =
    thread.replies == null ? '' : `${thread.replies} ${thread.replies === 1 ? 'reply' : 'replies'}`;
  return [replies, age].filter(Boolean).join(' · ');
}

export function spaceRowText(space: SpaceRow, now: number, width: number): string {
  const age = relativeAge(space.updatedMs, now);
  const right = [space.badge, age].filter(Boolean).join(' · ');
  const text = space.description ? `${space.label} · ${space.description}` : space.label;
  return layoutRow(text, right, Math.max(width - 1, 0));
}

export function threadRowText(thread: ThreadRow, now: number, width: number): string {
  return layoutRow(thread.title, threadRightText(thread, now), Math.max(width - 1, 0));
}

export function SpacesView({
  spaces,
  threads,
  focused,
  width,
  height,
  now,
  loading,
  threadsLoading,
  errorMessage,
  threadsError,
  busyMessage = null,
  onOpenSpace,
  onOpenThread,
  onNewThread,
  onOpenBrowser,
  onRefresh,
  onBack,
}: SpacesViewProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [spaceCursor, setSpaceCursor] = useState<string | null>(spaces[0]?.id ?? null);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);

  const openSpace = spaces.find((space) => space.id === openId) ?? null;
  const items = openSpace ? threads : spaces;
  const cursorId = openSpace ? threadCursor : spaceCursor;

  const cursorIndex = useMemo(() => {
    const found = items.findIndex((item) => item.id === cursorId);
    return found >= 0 ? found : 0;
  }, [items, cursorId]);
  const currentSpace = openSpace ?? spaces[cursorIndex] ?? null;

  const moveTo = useCallback(
    (index: number) => {
      const item = items[Math.min(Math.max(index, 0), items.length - 1)];
      if (!item) return;
      if (openSpace) setThreadCursor(item.id);
      else setSpaceCursor(item.id);
    },
    [items, openSpace],
  );

  useKeyboard((key) => {
    if (!focused) return;
    if (matchesSpacesBinding(key, 'back')) {
      if (openSpace) {
        setOpenId(null);
        setThreadCursor(null);
        onOpenSpace(null);
        return;
      }
      return onBack();
    }
    if (matchesSpacesBinding(key, 'down')) return moveTo(cursorIndex + 1);
    if (matchesSpacesBinding(key, 'up')) return moveTo(cursorIndex - 1);
    if (matchesSpacesBinding(key, 'first')) return moveTo(0);
    if (matchesSpacesBinding(key, 'last')) return moveTo(items.length - 1);
    if (matchesSpacesBinding(key, 'refresh')) return onRefresh();
    if (matchesSpacesBinding(key, 'browser')) {
      if (currentSpace) onOpenBrowser(currentSpace);
      return;
    }
    if (matchesSpacesBinding(key, 'new')) {
      if (openSpace) onNewThread(openSpace);
      return;
    }
    if (matchesSpacesBinding(key, 'open')) {
      const item = items[cursorIndex];
      if (!item) return;
      if (openSpace) return onOpenThread(item.id);
      setOpenId(item.id);
      setThreadCursor(null);
      onOpenSpace(item.id);
    }
  });

  const bodyWidth = Math.max(width - 1, 0);
  const listLoading = openSpace ? threadsLoading : loading;
  const error = openSpace ? threadsError : errorMessage;
  const rowsAvailable = Math.max(height - (openSpace ? 3 : 2) - (busyMessage ? 1 : 0), 1);
  const start = windowStart(cursorIndex, items.length, rowsAvailable);
  const visible = items.slice(start, start + rowsAvailable);
  const hints = openSpace
    ? 'Enter open session · n new thread · o browser · r refresh · Esc back'
    : 'Enter threads · o browser · r refresh · Esc back';

  return (
    <box flexDirection="column" width={width}>
      {openSpace ? (
        <>
          <text fg={theme.fg}>{layoutRow(openSpace.label, `${threads.length} threads`, bodyWidth)}</text>
          <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        </>
      ) : null}

      {visible.map((item) => {
        const isCursor = item.id === items[cursorIndex]?.id;
        const body = openSpace
          ? threadRowText(item as ThreadRow, now, width)
          : spaceRowText(item as SpaceRow, now, width);
        return (
          <text
            key={item.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            {body}
          </text>
        );
      })}

      {listLoading && items.length === 0 ? (
        <Spinner label={openSpace ? 'loading threads' : 'loading spaces'} />
      ) : null}
      {!listLoading && !error && items.length === 0 ? (
        <text fg={theme.faint}>
          {openSpace
            ? 'No threads in this space yet. Press n to start one.'
            : 'No channels or DMs yet.'}
        </text>
      ) : null}
      {error ? <text fg={theme.danger}>{layoutRow(error, '', bodyWidth)}</text> : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      <text fg={theme.faint}>{layoutRow(hints, '', bodyWidth)}</text>
    </box>
  );
}
