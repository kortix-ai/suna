/**
 * The Artifacts screen, as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * like `features/apps/apps-view.tsx`. `artifacts-screen.tsx` owns the SDK.
 * A doc's Markdown is drawn with the transcript's own `TextPart`.
 *
 * Overlays are drawn IN the column, never as `ui/Modal` (see `apps-view.tsx`).
 */

import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { formatBytes } from '../files/index.ts';
import { TextPart } from '../session/transcript/parts/text-part.tsx';
import { type ArtifactRow, VISIBILITY_PHRASE, filterArtifactRows } from './artifacts-model.ts';
import { matchesArtifactsBinding } from './keys.ts';

/** The opened artifact: its files, and a doc's text. Read only while open. */
export interface ArtifactDetailData {
  loading: boolean;
  errorMessage: string | null;
  files: Array<{ path: string; size: number }>;
  /** A doc's Markdown. `null` for an HTML page, or while it loads. */
  text: string | null;
  textLoading: boolean;
  textError: string | null;
}

export interface ArtifactsViewProps {
  rows: ArtifactRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  /** Replaces the list with one line that names why there is no list. */
  unavailable?: string | null;
  /** Rendered in place of the list. The SDK error message, verbatim. */
  errorMessage: string | null;
  /** One dim line under the list: `saving…`. */
  busyMessage?: string | null;
  detail: ArtifactDetailData | null;
  /** `null` closes the pane. The caller fetches the detail for a non-null id. */
  onOpenDetails(artifactId: string | null): void;
  onOpenWeb(row: ArtifactRow): void;
  onCopyLink(row: ArtifactRow): void;
  onRefresh(): void;
  onRename(row: ArtifactRow, title: string): void;
  onPin(row: ArtifactRow): void;
  onDelete(row: ArtifactRow): void;
  onOpenSession(sessionId: string): void;
  /** Esc with nothing open. */
  onBack(): void;
}

type Mode = 'browse' | 'details' | 'filter' | 'rename' | 'confirm-delete';

const LABEL_WIDTH = 14;

function Field({ label, value, fg }: { label: string; value: string; fg?: string }) {
  return (
    <text fg={fg ?? theme.fg}>
      <span fg={theme.faint}>{label.padEnd(LABEL_WIDTH, ' ')}</span>
      {value}
    </text>
  );
}

/** One list row, cursor gutter excluded: `<title>   <kind> · <author> · <age>`. */
export function artifactRowText(row: ArtifactRow, now: number, width: number): string {
  const age = relativeAge(row.updatedMs, now);
  const right = [row.kind, row.author, age].filter(Boolean).join(' · ');
  const title = row.pinned ? `${row.title} (pinned)` : row.title;
  return layoutRow(title, right, Math.max(width - 1, 0));
}

export function ArtifactsView({
  rows: allRows,
  focused,
  width,
  height,
  now,
  loading,
  unavailable = null,
  errorMessage,
  busyMessage = null,
  detail,
  onOpenDetails,
  onOpenWeb,
  onCopyLink,
  onRefresh,
  onRename,
  onPin,
  onDelete,
  onOpenSession,
  onBack,
}: ArtifactsViewProps) {
  const [mode, setMode] = useState<Mode>('browse');
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [textOffset, setTextOffset] = useState(0);

  const rows = useMemo(() => filterArtifactRows(allRows, filter), [allRows, filter]);
  const cursorIndex = useMemo(() => {
    const found = rows.findIndex((row) => row.id === cursorId);
    return found >= 0 ? found : 0;
  }, [rows, cursorId]);
  const current = rows[cursorIndex] ?? null;

  const moveTo = useCallback(
    (index: number) => {
      const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      if (row) setCursorId(row.id);
    },
    [rows],
  );

  const closeDetails = useCallback(() => {
    setMode('browse');
    setTextOffset(0);
    onOpenDetails(null);
  }, [onOpenDetails]);

  const textLines = detail?.text ? detail.text.split('\n').length : 0;
  const textRows = Math.max(height - 12, 3);
  const maxTextOffset = Math.max(textLines - textRows, 0);

  useKeyboard((key) => {
    if (!focused || unavailable) return;

    if (mode === 'filter') {
      // The `<input>` owns every other key while it is open.
      if (matchesArtifactsBinding(key, 'artifacts.back')) {
        setFilter('');
        setMode('browse');
      }
      return;
    }

    if (mode === 'rename') {
      if (matchesArtifactsBinding(key, 'artifacts.back')) return setMode('browse');
      if (matchesArtifactsBinding(key, 'artifacts.submit')) {
        const title = draft.trim();
        const target = current;
        setMode('browse');
        if (target && title && title !== target.title) onRename(target, title);
      }
      return;
    }

    if (mode === 'confirm-delete') {
      if (matchesArtifactsBinding(key, 'artifacts.back') || matchesArtifactsBinding(key, 'artifacts.deny'))
        return setMode('browse');
      if (matchesArtifactsBinding(key, 'artifacts.confirm')) {
        const target = current;
        closeDetails();
        if (target) onDelete(target);
      }
      return;
    }

    if (matchesArtifactsBinding(key, 'artifacts.back')) {
      if (mode === 'details') return closeDetails();
      if (filter) return setFilter('');
      return onBack();
    }
    if (matchesArtifactsBinding(key, 'artifacts.open')) return current ? onOpenWeb(current) : undefined;
    if (matchesArtifactsBinding(key, 'artifacts.copy')) return current ? onCopyLink(current) : undefined;
    if (matchesArtifactsBinding(key, 'artifacts.session')) {
      if (current?.sessionId) onOpenSession(current.sessionId);
      return;
    }
    if (matchesArtifactsBinding(key, 'artifacts.pin')) {
      if (current?.canManage) onPin(current);
      return;
    }
    if (matchesArtifactsBinding(key, 'artifacts.rename')) {
      if (!current?.canManage) return;
      setDraft(current.title);
      return setMode('rename');
    }
    if (matchesArtifactsBinding(key, 'artifacts.delete')) {
      if (current?.canManage) setMode('confirm-delete');
      return;
    }

    if (mode === 'details') {
      if (matchesArtifactsBinding(key, 'artifacts.textDown'))
        return setTextOffset((offset) => Math.min(offset + textRows, maxTextOffset));
      if (matchesArtifactsBinding(key, 'artifacts.textUp'))
        return setTextOffset((offset) => Math.max(offset - textRows, 0));
      return;
    }

    if (matchesArtifactsBinding(key, 'artifacts.down')) return moveTo(cursorIndex + 1);
    if (matchesArtifactsBinding(key, 'artifacts.up')) return moveTo(cursorIndex - 1);
    if (matchesArtifactsBinding(key, 'artifacts.first')) return moveTo(0);
    if (matchesArtifactsBinding(key, 'artifacts.last')) return moveTo(rows.length - 1);
    if (matchesArtifactsBinding(key, 'artifacts.refresh')) return onRefresh();
    if (matchesArtifactsBinding(key, 'artifacts.filter')) return setMode('filter');
    if (matchesArtifactsBinding(key, 'artifacts.details')) {
      if (!current) return;
      setMode('details');
      setTextOffset(0);
      onOpenDetails(current.id);
    }
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (unavailable) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>{unavailable}</text>
      </box>
    );
  }

  if (mode === 'details' && current) {
    const updated = relativeAge(current.updatedMs, now);
    const body = detail?.text
      ? detail.text.split('\n').slice(textOffset, textOffset + textRows).join('\n')
      : '';
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.fg}>
          {layoutRow(current.title, current.pinned ? `${current.kind} · pinned` : current.kind, bodyWidth)}
        </text>
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        <Field label="Path" value={current.path} />
        <Field
          label="Who can open"
          value={
            VISIBILITY_PHRASE[current.visibility]
              ? `${current.visibility} — ${VISIBILITY_PHRASE[current.visibility]}`
              : current.visibility
          }
        />
        <Field label="Author" value={current.author || '—'} />
        <Field label="Updated" value={updated ? `${updated} ago` : '—'} />
        {current.description ? <Field label="Description" value={current.description} /> : null}
        <Field label="Link" value={current.webUrl} />
        {current.publicUrl ? <Field label="Public link" value={current.publicUrl} /> : null}
        <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {detail?.errorMessage ? (
          <text fg={theme.danger}>{layoutRow(detail.errorMessage, '', bodyWidth)}</text>
        ) : null}
        {detail?.loading ? <Spinner label="loading artifact" /> : null}
        {current.kind === 'doc' ? (
          <>
            {detail?.textLoading ? <Spinner label="loading document" /> : null}
            {detail?.textError ? (
              <text fg={theme.danger}>{layoutRow(detail.textError, '', bodyWidth)}</text>
            ) : null}
            {body ? (
              <box height={textRows} overflow="hidden" width={width}>
                <TextPart text={body} streaming={false} width={bodyWidth} />
              </box>
            ) : null}
          </>
        ) : (
          (detail?.files ?? []).slice(0, textRows).map((file) => (
            <text key={file.path} fg={theme.dim}>
              {layoutRow(file.path, formatBytes(file.size), bodyWidth)}
            </text>
          ))
        )}
        <text fg={theme.faint}>
          {current.kind === 'doc' ? 'J/K scroll · ' : ''}o web · y copy link · Esc back
        </text>
      </box>
    );
  }

  const confirming = mode === 'confirm-delete';
  const renaming = mode === 'rename';
  const filtering = mode === 'filter';
  const overlayRows = confirming ? 3 : renaming || filtering ? 1 : 0;
  const rowsAvailable = Math.max(height - overlayRows - (busyMessage ? 1 : 0) - 1, 1);
  const start = windowStart(cursorIndex, rows.length, rowsAvailable);
  const visible = rows.slice(start, start + rowsAvailable);
  const hints = [
    'Enter open',
    'o web',
    'y copy link',
    '/ filter',
    current?.canManage ? 'e rename · p pin · d stop sharing' : null,
    current?.sessionId ? 's session' : null,
    'r refresh',
    'Esc back',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <box flexDirection="column" width={width}>
      {confirming && current ? (
        <box flexDirection="column" width={width}>
          <text fg={theme.fg}>Stop sharing this artifact</text>
          <text fg={theme.dim}>{layoutRow(`${current.title} — its files stay in Files`, '', bodyWidth)}</text>
          <text fg={theme.faint}>y confirm · n or Esc cancel</text>
        </box>
      ) : null}
      {renaming ? (
        <box flexDirection="row" width={width}>
          <text fg={theme.accent}>rename </text>
          <input
            focused
            flexGrow={1}
            value={draft}
            placeholder="new title"
            onInput={(value: string) => setDraft(value)}
          />
        </box>
      ) : null}
      {filtering ? (
        <box flexDirection="row" width={width}>
          <text fg={theme.accent}>/</text>
          <input
            focused
            flexGrow={1}
            value={filter}
            placeholder="filter by title, path or author"
            onInput={(value: string) => setFilter(value)}
            onSubmit={() => setMode('browse')}
          />
        </box>
      ) : null}

      {visible.map((row) => {
        const isCursor = row.id === current?.id;
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            {artifactRowText(row, now, width)}
          </text>
        );
      })}

      {loading && allRows.length === 0 ? <Spinner label="loading artifacts" /> : null}
      {!loading && !errorMessage && allRows.length === 0 ? (
        <box flexDirection="column">
          <text fg={theme.fg}>No artifacts yet</text>
          <text fg={theme.faint}>An agent shares a document or page from Files to publish one.</text>
        </box>
      ) : null}
      {!errorMessage && allRows.length > 0 && rows.length === 0 ? (
        <text fg={theme.faint}>No artifact matches the filter.</text>
      ) : null}
      {errorMessage ? <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text> : null}
      {busyMessage ? <text fg={theme.faint}>{busyMessage}</text> : null}
      {allRows.length > 0 ? <text fg={theme.faint}>{hints}</text> : null}
    </box>
  );
}
