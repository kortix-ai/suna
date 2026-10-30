/**
 * The Drive screen, as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * exactly like `features/apps/apps-view.tsx`. That split is what lets
 * `drive-view.test.tsx` assert real frames against fixture rows with no mocked
 * module, while `drive-screen.tsx` owns the SDK.
 *
 * One list, three contents: Places (the web's rail: My files, Shared with me,
 * Team folders, This session, All files), one folder's entries, or the open
 * conflict copies. A file opens in the Files screen's `<FileViewer/>` on the
 * right. Inputs and confirms are drawn IN the column, never as `ui/Modal`:
 * `ui/panel.tsx` clips an absolute overlay to the panel (see `apps-view.tsx`).
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { FileViewer, type ViewerState, viewerLines } from '../files/index.ts';
import { type DriveRow, filterDriveRows, isSelectable } from './drive-model.ts';
import { matchesDriveBinding } from './keys.ts';

/** What the list shows. */
export type DriveList = 'places' | 'folder' | 'conflicts';

/**
 * Drive cannot be browsed: no project, flag off, identity or drive failed, or
 * still loading. One state line replaces the browser.
 */
export interface DriveNotice {
  tone: 'loading' | 'info' | 'error';
  message: string;
  /** A second, dim line: the remedy. */
  hint?: string;
}

type InputKind = 'mkdir' | 'move' | 'upload';
type ConfirmKind = 'delete' | 'replace';

export interface DriveViewProps {
  focused: boolean;
  width: number;
  height: number;
  /** Non-null: draw this instead of the browser. */
  notice: DriveNotice | null;
  list: DriveList;
  /** `My files / Memory / 2026`, `Places`, `Conflicts`. */
  crumb: string;
  rows: DriveRow[];
  /** The list is in flight and has no rows yet. */
  loading: boolean;
  /** Drawn under the rows. The SDK error, with its HTTP status. */
  errorMessage: string | null;
  /**
   * Identifies what the list shows (the folder path, `places`, `conflicts`).
   * When it changes, the filter clears and the cursor moves to `cursorHint`.
   */
  locationKey: string;
  /** The row id to select after a move: the folder just left, going up. */
  cursorHint?: string | null;
  /** The caller may write in the folder on screen: `n` and `u` work. */
  canWrite: boolean;
  /** Open conflict copies. Shown in the header when above zero. */
  conflictCount: number;
  viewer: ViewerState;
  /** One dim line under the list: `deleting…`, `uploading…`. */
  busyMessage?: string | null;
  onOpen(row: DriveRow): void;
  /** Up one folder, or back to Places from the top of a place. */
  onParent(): void;
  onMakeFolder(name: string): void;
  onMove(row: DriveRow, to: string): void;
  onDelete(row: DriveRow): void;
  /** `localPath` as typed. The view already asked before replacing a file. */
  onUpload(localPath: string): void;
  /** `null`: the folder on screen (or, in a notice, the settings page). */
  onOpenWeb(row: DriveRow | null): void;
  onCopy(row: DriveRow | null): void;
  onRefresh(): void;
  onShowConflicts(open: boolean): void;
  onDismissConflict(row: DriveRow): void;
  onCloseViewer(): void;
  /** A refusal the view decides on its own: read-only row, nothing selected. */
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** Esc with nothing open. */
  onBack(): void;
}

/** The list column while a file is open: two fifths, inside a readable band. */
export function listColumnWidth(width: number): number {
  return Math.min(Math.max(Math.floor(width * 0.4), 24), 48);
}

/** The last path segment a person typed, for "a file with this name exists". */
function localBaseName(localPath: string): string {
  const trimmed = localPath.trim().replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

const INPUT_LABEL: Record<InputKind, string> = {
  mkdir: 'New folder name',
  move: 'Move to (a name renames, a /path moves)',
  upload: 'Local file to upload',
};

export function DriveView({
  focused,
  width,
  height,
  notice,
  list,
  crumb,
  rows: allRows,
  loading,
  errorMessage,
  locationKey,
  cursorHint = null,
  canWrite,
  conflictCount,
  viewer,
  busyMessage = null,
  onOpen,
  onParent,
  onMakeFolder,
  onMove,
  onDelete,
  onUpload,
  onOpenWeb,
  onCopy,
  onRefresh,
  onShowConflicts,
  onDismissConflict,
  onCloseViewer,
  onToast,
  onBack,
}: DriveViewProps) {
  const [mode, setMode] = useState<'browse' | 'filter' | 'input' | 'confirm'>('browse');
  const [inputKind, setInputKind] = useState<InputKind>('mkdir');
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>('delete');
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');
  const [cursorId, setCursorId] = useState<string | null>(cursorHint);
  /** The row an input or confirm acts on, pinned when it opened. */
  const [target, setTarget] = useState<DriveRow | null>(null);
  const [viewerOffset, setViewerOffset] = useState(0);

  // A new folder, Places or the conflicts: a fresh list. The cursor lands on
  // the row the caller names (the folder just left) and the filter clears.
  useEffect(() => {
    setCursorId(cursorHint);
    setFilter('');
    setMode('browse');
  }, [locationKey, cursorHint]);

  useEffect(() => setViewerOffset(0), [viewer]);

  const rows = useMemo(() => filterDriveRows(allRows, filter), [allRows, filter]);

  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId && isSelectable(row));
    if (found >= 0) return found;
    return rows.findIndex(isSelectable);
  }, [rows, cursorId]);
  const current: DriveRow | null = cursorIndex >= 0 ? (rows[cursorIndex] ?? null) : null;

  /** Step `delta` selectable rows from the cursor, clamped at both ends. */
  const step = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      let index = cursorIndex;
      let moved = 0;
      while (moved < Math.abs(delta)) {
        let next = index + Math.sign(delta);
        while (next >= 0 && next < rows.length && !isSelectable(rows[next] as DriveRow)) next += Math.sign(delta);
        if (next < 0 || next >= rows.length) break;
        index = next;
        moved += 1;
      }
      const row = rows[index];
      if (row) setCursorId(row.id);
    },
    [rows, cursorIndex],
  );

  const jumpTo = useCallback(
    (end: 'first' | 'last') => {
      const candidates = rows.filter(isSelectable);
      const row = end === 'first' ? candidates[0] : candidates[candidates.length - 1];
      if (row) setCursorId(row.id);
    },
    [rows],
  );

  const viewerOpen = viewer.kind !== 'empty';
  const viewerRows = Math.max(height - 3, 1);
  const maxViewerOffset = Math.max(viewerLines(viewer).length - viewerRows, 0);

  const openInput = useCallback((kind: InputKind, row: DriveRow | null, value: string) => {
    setInputKind(kind);
    setTarget(row);
    setDraft(value);
    setMode('input');
  }, []);

  const closeOverlay = useCallback(() => {
    setMode('browse');
    setTarget(null);
    setDraft('');
  }, []);

  const submitInput = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text) return closeOverlay();
      if (inputKind === 'mkdir') {
        closeOverlay();
        onMakeFolder(text);
        return;
      }
      if (inputKind === 'move') {
        const row = target;
        closeOverlay();
        if (row) onMove(row, text);
        return;
      }
      // Upload replaces any file at the path (`uploadDriveFile`), so a name
      // already in this folder asks first.
      const name = localBaseName(text);
      if (allRows.some((row) => row.kind === 'file' && row.name === name)) {
        setDraft(text);
        setConfirmKind('replace');
        setMode('confirm');
        return;
      }
      closeOverlay();
      onUpload(text);
    },
    [inputKind, target, allRows, closeOverlay, onMakeFolder, onMove, onUpload],
  );

  /** Refuse a write here with a reason, or return true. */
  const mayWriteHere = useCallback((): boolean => {
    if (list !== 'folder') {
      onToast('Open a folder first.', 'error');
      return false;
    }
    if (!canWrite) {
      onToast('You can only read this folder.', 'error');
      return false;
    }
    return true;
  }, [list, canWrite, onToast]);

  const mayChange = useCallback(
    (row: DriveRow | null): row is DriveRow => {
      if (list !== 'folder' || !row || (row.kind !== 'file' && row.kind !== 'dir')) {
        onToast('Select a file or folder first.', 'error');
        return false;
      }
      if (row.readOnly) {
        onToast(`You can only read ${row.name}.`, 'error');
        return false;
      }
      return true;
    },
    [list, onToast],
  );

  useKeyboard((key) => {
    if (!focused) return;

    if (notice) {
      if (matchesDriveBinding(key, 'drive.back')) return onBack();
      if (matchesDriveBinding(key, 'drive.openWeb')) return onOpenWeb(null);
      if (matchesDriveBinding(key, 'drive.refresh')) return onRefresh();
      return;
    }

    if (mode === 'input' || mode === 'filter') {
      // The `<input>` owns every other key while it is open.
      if (matchesDriveBinding(key, 'drive.back')) {
        if (mode === 'filter') setFilter('');
        closeOverlay();
      }
      return;
    }

    if (mode === 'confirm') {
      if (matchesDriveBinding(key, 'drive.confirm')) {
        const row = target;
        const pending = draft;
        closeOverlay();
        if (confirmKind === 'delete' && row) onDelete(row);
        if (confirmKind === 'replace') onUpload(pending);
        return;
      }
      // y/N: anything else keeps the file.
      closeOverlay();
      return;
    }

    if (matchesDriveBinding(key, 'drive.viewerDown') && viewerOpen)
      return setViewerOffset((offset) => Math.min(offset + viewerRows, maxViewerOffset));
    if (matchesDriveBinding(key, 'drive.viewerUp') && viewerOpen)
      return setViewerOffset((offset) => Math.max(offset - viewerRows, 0));
    if (matchesDriveBinding(key, 'drive.down')) return step(1);
    if (matchesDriveBinding(key, 'drive.up')) return step(-1);
    if (matchesDriveBinding(key, 'drive.first')) return jumpTo('first');
    if (matchesDriveBinding(key, 'drive.last')) return jumpTo('last');
    if (matchesDriveBinding(key, 'drive.open')) {
      if (current) onOpen(current);
      return;
    }
    if (matchesDriveBinding(key, 'drive.parent')) {
      if (list === 'conflicts') return onShowConflicts(false);
      if (list === 'folder') onParent();
      return;
    }
    if (matchesDriveBinding(key, 'drive.filter')) return setMode('filter');
    if (matchesDriveBinding(key, 'drive.refresh')) return onRefresh();
    if (matchesDriveBinding(key, 'drive.copy')) return onCopy(current);
    if (matchesDriveBinding(key, 'drive.openWeb')) return onOpenWeb(current);
    if (matchesDriveBinding(key, 'drive.conflicts')) return onShowConflicts(list !== 'conflicts');
    if (matchesDriveBinding(key, 'drive.dismiss')) {
      if (list === 'conflicts' && current?.kind === 'conflict') onDismissConflict(current);
      return;
    }
    if (matchesDriveBinding(key, 'drive.newFolder')) {
      if (mayWriteHere()) openInput('mkdir', null, '');
      return;
    }
    if (matchesDriveBinding(key, 'drive.upload')) {
      if (mayWriteHere()) openInput('upload', null, '');
      return;
    }
    if (matchesDriveBinding(key, 'drive.move')) {
      if (mayChange(current)) openInput('move', current, current.name);
      return;
    }
    if (matchesDriveBinding(key, 'drive.delete')) {
      if (!mayChange(current)) return;
      setTarget(current);
      setConfirmKind('delete');
      setMode('confirm');
      return;
    }
    if (matchesDriveBinding(key, 'drive.back')) {
      if (filter) return setFilter('');
      if (viewerOpen) return onCloseViewer();
      if (list === 'conflicts') return onShowConflicts(false);
      return onBack();
    }
  });

  const fullBody = Math.max(width - 1, 0);

  if (notice) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>Drive</text>
        {notice.tone === 'loading' ? (
          <Spinner label={notice.message} />
        ) : (
          <text fg={notice.tone === 'error' ? theme.danger : theme.dim}>
            {layoutRow(notice.message, '', fullBody)}
          </text>
        )}
        {notice.hint ? <text fg={theme.faint}>{layoutRow(notice.hint, '', fullBody)}</text> : null}
      </box>
    );
  }

  const columnWidth = viewerOpen ? listColumnWidth(width) : width;
  const bodyWidth = Math.max(columnWidth - 1, 0);
  const overlayRows = mode === 'input' || mode === 'filter' ? 2 : mode === 'confirm' ? 2 : 0;
  // Header, rule, two hint rows, the busy line, and the overlay.
  const listRows = Math.max(height - 4 - (busyMessage ? 1 : 0) - overlayRows, 1);
  const start = windowStart(Math.max(cursorIndex, 0), rows.length, listRows);
  const visible = rows.slice(start, start + listRows);
  const badge = conflictCount > 0 ? `${conflictCount} ${conflictCount === 1 ? 'conflict' : 'conflicts'}` : '';

  const hints =
    list === 'places'
      ? ['Enter open · / filter · c conflicts', 'r reload · Esc back']
      : list === 'conflicts'
        ? ['Enter open folder · x dismiss', 'y copy · Esc back']
        : [
            'Enter open · ⌫ up · / filter · o web · y copy',
            canWrite ? 'n folder · m move · d delete · u upload · r reload' : 'read only · r reload',
          ];

  const confirmText =
    confirmKind === 'replace'
      ? `Replace ${localBaseName(draft)} in this folder?`
      : target?.kind === 'dir'
        ? `Delete folder ${target.name} and everything in it?`
        : `Delete ${target?.name ?? ''}?`;

  return (
    <box flexDirection="row" width={width} height={height}>
      <box flexDirection="column" width={columnWidth}>
        <text fg={focused ? theme.fg : theme.dim}>
          {layoutRow(crumb, badge, bodyWidth)}
        </text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>

        {mode === 'filter' ? (
          <box flexDirection="column" width={columnWidth}>
            <box flexDirection="row" width={columnWidth}>
              <text fg={theme.accent}>/</text>
              <input
                focused
                flexGrow={1}
                value={filter}
                placeholder="filter by name"
                onInput={(value: string) => setFilter(value)}
                onSubmit={() => setMode('browse')}
              />
            </box>
            <text fg={theme.faint}>Enter keep · Esc clear</text>
          </box>
        ) : null}

        {mode === 'input' ? (
          <box flexDirection="column" width={columnWidth}>
            <text fg={theme.fg}>{layoutRow(INPUT_LABEL[inputKind], '', bodyWidth)}</text>
            <box flexDirection="row" width={columnWidth}>
              <text fg={theme.accent}>›</text>
              <input
                focused
                flexGrow={1}
                value={draft}
                onInput={(value: string) => setDraft(value)}
                onSubmit={(value: unknown) => submitInput(typeof value === 'string' ? value : draft)}
              />
            </box>
          </box>
        ) : null}

        {mode === 'confirm' ? (
          <box flexDirection="column" width={columnWidth}>
            <text fg={theme.fg}>{layoutRow(confirmText, '', bodyWidth)}</text>
            <text fg={theme.faint}>
              {layoutRow(confirmKind === 'delete' ? 'y delete · any other key keeps it' : 'y replace · any other key keeps it', '', bodyWidth)}
            </text>
          </box>
        ) : null}

        {visible.map((row) => {
          if (row.kind === 'heading') {
            return (
              <text key={row.id} fg={theme.faint}>
                {` ${layoutRow(row.name, '', Math.max(bodyWidth - 1, 0))}`}
              </text>
            );
          }
          if (row.kind === 'note') {
            return (
              <text key={row.id} fg={theme.faint}>
                {`   ${layoutRow(row.name, '', Math.max(bodyWidth - 3, 0))}`}
              </text>
            );
          }
          const isCursor = row.id === current?.id;
          const mark =
            row.kind === 'dir' || row.kind === 'place' ? GLYPH.collapsed : row.kind === 'conflict' ? GLYPH.failed : ' ';
          const indent = list === 'places' && row.kind === 'place' && !row.id.startsWith('mine:') ? '  ' : '';
          const name = row.kind === 'dir' ? `${row.name}/` : row.name;
          const body = layoutRow(`${indent}${mark} ${name}`, row.meta, bodyWidth);
          return (
            <text
              key={row.id}
              fg={isCursor ? theme.fg : row.readOnly ? theme.faint : theme.dim}
              bg={isCursor ? theme.surface : undefined}
            >
              <span fg={theme.accent}>{isCursor && focused ? GLYPH.selected : ' '}</span>
              {body}
            </text>
          );
        })}

        {loading && rows.length === 0 ? (
          <Spinner label={list === 'conflicts' ? 'loading conflicts' : 'loading folder'} />
        ) : null}
        {!loading && !errorMessage && rows.length === 0 ? (
          <text fg={theme.faint}>
            {filter
              ? 'No match.'
              : list === 'conflicts'
                ? 'No open conflicts.'
                : list === 'places'
                  ? 'No places yet.'
                  : canWrite
                    ? 'Empty folder. n makes a folder, u uploads a file.'
                    : 'Empty folder.'}
          </text>
        ) : null}
        {errorMessage ? (
          <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text>
        ) : null}
        {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
        {hints.map((hint) => (
          <text key={hint} fg={theme.faint}>
            {layoutRow(hint, '', bodyWidth)}
          </text>
        ))}
      </box>

      {viewerOpen ? (
        <>
          {/* The column rule, as ONE text whose content carries the newlines
              (same reason as `files-screen.tsx`). */}
          <text fg={theme.border} width={1} flexShrink={0}>
            {Array(Math.max(height, 1)).fill('│').join('\n')}
          </text>
          <box flexDirection="column" flexGrow={1}>
            <FileViewer
              state={viewer}
              offset={viewerOffset}
              width={Math.max(width - columnWidth - 1, 10)}
              height={Math.max(height - 1, 1)}
              focused={focused}
            />
            <text fg={theme.faint}>J/K scroll · Esc close</text>
          </box>
        </>
      ) : null}
    </box>
  );
}
