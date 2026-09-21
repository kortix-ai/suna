/**
 * The sidebar, as pixels and keys only.
 *
 * Everything this component draws arrives as a prop, and everything it does
 * leaves as a callback. No SDK call, no query, no client. That split is what
 * lets the frame assertions in `sidebar-view.test.tsx` run against fixture
 * data with no mocked module, while `sidebar.tsx` owns the real data path.
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import {
  type SessionDayGroup,
  type SessionLike,
  sessionActivityMs,
  sessionTitle,
} from '../../lib/session-groups.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { matchesSidebarBinding } from './keys.ts';

/** The screens the sidebar's nav rows route to. */
export type SidebarScreen = 'customize' | 'apps' | 'review' | 'files';

/** A row id. `session:<id>` for a session, a bare word for a nav row. */
type EntryId = string;

interface RenderEntry {
  key: string;
  /** Present on a row the cursor can land on. A header cannot be selected. */
  id?: EntryId;
  label: string;
  right?: string;
  glyph?: string;
  glyphColor?: string;
  depth?: number;
  /** Set on a session row. */
  sessionId?: string;
  /** A dim, non-selectable day header. */
  header?: boolean;
  /** A spacer row. */
  blank?: boolean;
}

export interface SidebarViewProps {
  accountName: string;
  projectName: string;
  /** Open change requests. `null` prints no count. */
  reviewCount: number | null;
  groups: SessionDayGroup<SessionLike>[];
  selectedSessionId: string | null;
  /** The sidebar answers keys only when it is the focused region. */
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column is rendered against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** Rendered in place of the list. The SDK error message, verbatim. */
  errorMessage: string | null;
  /** One dim line under the list: `creating session…`, `loading more…`. */
  busyMessage?: string | null;
  onOpenSession(sessionId: string): void;
  onOpenAccountPicker(): void;
  onOpenProjectPicker(): void;
  onNewSession(): void;
  onNavigate(screen: SidebarScreen): void;
  onRename(sessionId: string, name: string): void;
  onDelete(sessionId: string): void;
  onAttach(sessionId: string): void;
  onFilterChange?(query: string): void;
  /** The cursor reached the last session row — the caller may page. */
  onReachEnd?(): void;
}

function statusGlyph(status: string | undefined, depth: number): string {
  // A child prints the spawn mark instead of its own status glyph: the link to
  // the row above is the fact the indent is there to carry, and 28 columns do
  // not have room for both. Its status still reads through the glyph color.
  if (depth > 0) return GLYPH.child;
  if (status === 'failed') return GLYPH.failed;
  if (status === 'running' || status === 'queued' || status === 'branching') return GLYPH.running;
  if (status === 'provisioning') return GLYPH.running;
  return GLYPH.stopped;
}

function statusColor(status: string | undefined): string {
  if (status === 'failed') return theme.danger;
  if (status === 'running' || status === 'provisioning' || status === 'branching')
    return theme.busy;
  if (status === 'queued') return theme.busy;
  return theme.faint;
}

export function SidebarView({
  accountName,
  projectName,
  reviewCount,
  groups,
  selectedSessionId,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  busyMessage = null,
  onOpenSession,
  onOpenAccountPicker,
  onOpenProjectPicker,
  onNewSession,
  onNavigate,
  onRename,
  onDelete,
  onAttach,
  onFilterChange,
  onReachEnd,
}: SidebarViewProps) {
  const [mode, setMode] = useState<'browse' | 'filter' | 'rename' | 'confirm-delete'>('browse');
  const [filter, setFilter] = useState('');
  const [draftName, setDraftName] = useState('');
  const [cursorId, setCursorId] = useState<EntryId>(
    selectedSessionId ? `session:${selectedSessionId}` : 'new',
  );
  /** Where the cursor was last, so a row that disappears (delete, filter)
   *  leaves the cursor near it instead of jumping back to the top. */
  const lastIndex = useRef(0);

  const sessionCount = useMemo(
    () => groups.reduce((total, group) => total + group.rows.length, 0),
    [groups],
  );

  const entries = useMemo<RenderEntry[]>(() => {
    const rows: RenderEntry[] = [
      {
        key: 'account',
        id: 'account',
        label: accountName,
        glyph: GLYPH.expanded,
        glyphColor: theme.dim,
      },
      {
        key: 'project',
        id: 'project',
        label: projectName,
        glyph: GLYPH.collapsed,
        glyphColor: theme.dim,
      },
      { key: 'new', id: 'new', label: '+ New session' },
      { key: 'customize', id: 'customize', label: '  Customize' },
      { key: 'apps', id: 'apps', label: '  Apps' },
      {
        key: 'review',
        id: 'review',
        label: '  Review',
        right: reviewCount ? String(reviewCount) : '',
      },
      { key: 'files', id: 'files', label: '  Files' },
      { key: 'gap', label: '', blank: true },
    ];
    for (const group of groups) {
      rows.push({ key: `header:${group.label}`, label: group.label, header: true });
      for (const row of group.rows) {
        const session = row.session;
        rows.push({
          key: `session:${session.session_id}`,
          id: `session:${session.session_id}`,
          sessionId: session.session_id,
          label: sessionTitle(session),
          right: relativeAge(sessionActivityMs(session), now),
          glyph: statusGlyph(session.status, row.depth),
          glyphColor: statusColor(session.status),
          depth: row.depth,
        });
      }
    }
    return rows;
  }, [accountName, projectName, reviewCount, groups, now]);

  const selectableIds = useMemo(
    () => entries.filter((entry) => entry.id).map((entry) => entry.id as EntryId),
    [entries],
  );

  const cursorIndex = useMemo(() => {
    const found = selectableIds.indexOf(cursorId);
    if (found >= 0) return found;
    return Math.min(Math.max(lastIndex.current, 0), Math.max(selectableIds.length - 1, 0));
  }, [selectableIds, cursorId]);

  useEffect(() => {
    lastIndex.current = cursorIndex;
  }, [cursorIndex]);

  const currentId = selectableIds[cursorIndex];
  const currentEntry = entries.find((entry) => entry.id === currentId);
  const currentSessionId = currentEntry?.sessionId ?? null;

  const moveTo = useCallback(
    (index: number) => {
      if (selectableIds.length === 0) return;
      const clamped = Math.min(Math.max(index, 0), selectableIds.length - 1);
      const id = selectableIds[clamped];
      if (!id) return;
      setCursorId(id);
      if (clamped === selectableIds.length - 1 && id.startsWith('session:')) onReachEnd?.();
    },
    [selectableIds, onReachEnd],
  );

  const openCurrent = useCallback(() => {
    if (!currentId) return;
    if (currentId === 'account') return onOpenAccountPicker();
    if (currentId === 'project') return onOpenProjectPicker();
    if (currentId === 'new') return onNewSession();
    if (currentId === 'customize' || currentId === 'apps' || currentId === 'files')
      return onNavigate(currentId);
    if (currentId === 'review') return onNavigate('review');
    if (currentSessionId) onOpenSession(currentSessionId);
  }, [
    currentId,
    currentSessionId,
    onOpenAccountPicker,
    onOpenProjectPicker,
    onNewSession,
    onNavigate,
    onOpenSession,
  ]);

  const leaveInput = useCallback(() => {
    setMode('browse');
    setDraftName('');
  }, []);

  const clearFilter = useCallback(() => {
    setMode('browse');
    setFilter('');
    onFilterChange?.('');
  }, [onFilterChange]);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'filter') {
      // The `<input>` owns every other key; Esc is the only chord that still
      // belongs to the sidebar while an input is open.
      if (matchesSidebarBinding(key, 'sidebar.cancel')) clearFilter();
      return;
    }
    if (mode === 'rename') {
      if (matchesSidebarBinding(key, 'sidebar.cancel')) leaveInput();
      return;
    }
    if (mode === 'confirm-delete') {
      if (matchesSidebarBinding(key, 'sidebar.cancel')) return leaveInput();
      if (matchesSidebarBinding(key, 'sidebar.deny')) return leaveInput();
      if (matchesSidebarBinding(key, 'sidebar.confirm')) {
        const target = currentSessionId;
        leaveInput();
        if (target) onDelete(target);
      }
      return;
    }

    if (matchesSidebarBinding(key, 'sidebar.down')) return moveTo(cursorIndex + 1);
    if (matchesSidebarBinding(key, 'sidebar.up')) return moveTo(cursorIndex - 1);
    if (matchesSidebarBinding(key, 'sidebar.last')) return moveTo(selectableIds.length - 1);
    if (matchesSidebarBinding(key, 'sidebar.first')) return moveTo(0);
    if (matchesSidebarBinding(key, 'sidebar.open')) return openCurrent();
    if (matchesSidebarBinding(key, 'sidebar.filter')) return setMode('filter');
    if (matchesSidebarBinding(key, 'sidebar.new')) return onNewSession();
    if (matchesSidebarBinding(key, 'sidebar.rename')) {
      if (!currentSessionId) return;
      setDraftName(currentEntry?.label ?? '');
      setMode('rename');
      return;
    }
    if (matchesSidebarBinding(key, 'sidebar.delete')) {
      if (currentSessionId) setMode('confirm-delete');
      return;
    }
    if (matchesSidebarBinding(key, 'sidebar.attach')) {
      if (currentSessionId) onAttach(currentSessionId);
    }
  });

  const confirming = mode === 'confirm-delete';
  const rowsAvailable = Math.max(
    height - (mode === 'filter' ? 1 : 0) - (busyMessage ? 1 : 0) - (confirming ? 3 : 0),
    1,
  );
  const cursorFlatIndex = Math.max(
    entries.findIndex((entry) => entry.id === currentId),
    0,
  );
  const start = windowStart(cursorFlatIndex, entries.length, rowsAvailable);
  const visible = entries.slice(start, start + rowsAvailable);
  const bodyWidth = Math.max(width - 1, 0);

  return (
    <box flexDirection="column" width={width}>
      {/* The confirm is drawn IN the column, not as a centered `Modal`:
          `ui/panel.tsx` sets `overflow: 'hidden'`, so an overlay a panel's
          subtree draws is scissored to that panel (proved with
          `scripts/dev-sidebar.tsx` + `SIDEBAR_NO_PANEL=1`). */}
      {confirming ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.danger}>Delete session</text>
          <text fg={theme.fg}>{layoutRow(currentEntry?.label ?? '', '', bodyWidth)}</text>
          <text fg={theme.faint}>y delete · Esc cancel</text>
        </box>
      ) : null}

      {mode === 'filter' ? (
        <box flexDirection="row" width={width}>
          <text fg={theme.accent}>/</text>
          <input
            focused
            flexGrow={1}
            value={filter}
            placeholder="filter sessions"
            onInput={(value: string) => {
              setFilter(value);
              onFilterChange?.(value);
            }}
            onSubmit={() => setMode('browse')}
          />
        </box>
      ) : null}

      {visible.map((entry) => {
        if (entry.blank) return <text key={entry.key}> </text>;
        if (entry.header) {
          return (
            <text key={entry.key} fg={theme.faint}>
              {layoutRow(entry.label, '', bodyWidth)}
            </text>
          );
        }
        const isCursor = entry.id === currentId;
        const isOpenSession = entry.sessionId != null && entry.sessionId === selectedSessionId;
        const indent = '  '.repeat(entry.depth ?? 0);
        const lead = entry.glyph ? `${entry.glyph} ` : '';
        const body = layoutRow(`${indent}${lead}${entry.label}`, entry.right ?? '', bodyWidth);
        const mark = isCursor && focused ? GLYPH.selected : ' ';
        const prefix = indent.length + lead.length;

        if (mode === 'rename' && isCursor) {
          return (
            <box key={entry.key} flexDirection="row" width={width}>
              <text fg={theme.accent}>{GLYPH.selected}</text>
              <input
                focused
                flexGrow={1}
                value={draftName}
                placeholder="new name"
                onInput={setDraftName}
                onSubmit={() => {
                  const next = draftName.trim();
                  const target = currentSessionId;
                  leaveInput();
                  if (next && target) onRename(target, next);
                }}
              />
            </box>
          );
        }

        return (
          <text
            key={entry.key}
            fg={isCursor || isOpenSession ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.accent}>{mark}</span>
            <span fg={entry.glyphColor ?? theme.dim}>{body.slice(0, prefix)}</span>
            {body.slice(prefix)}
          </text>
        );
      })}

      {loading && sessionCount === 0 ? <Spinner label="loading sessions" /> : null}
      {!loading && !errorMessage && sessionCount === 0 ? (
        <text fg={theme.faint}>{filter ? 'No match.' : 'No sessions yet.'}</text>
      ) : null}
      {errorMessage ? (
        <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
      ) : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
    </box>
  );
}
