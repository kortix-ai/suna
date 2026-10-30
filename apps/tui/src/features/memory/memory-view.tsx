/**
 * The Memory screen, as pixels and keys only.
 *
 * Everything drawn arrives as a prop and everything done leaves as a callback,
 * like `features/apps/apps-view.tsx`. `memory-screen.tsx` owns the SDK.
 *
 * Three modes: `browse` (the page list), `search` (the query line takes typed
 * text) and `read` (one page as Markdown). A query of 2 or more characters
 * makes the host swap `rows` for server hits; the view only draws the rows it
 * is given.
 */

import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { relativeAge } from '../../lib/relative-time.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { Spinner, layoutRow, windowStart } from '../../ui/index.ts';
import { TextPart } from '../session/transcript/parts/text-part.tsx';
import { editText, matchesMemoryBinding } from './keys.ts';

export interface MemoryRow {
  id: string;
  title: string;
  /** `people` · `decisions` · `workstreams` · `playbooks` · `note` · `other`. */
  type: string;
  summary: string;
  /** `updated_at` in epoch ms. `NaN` for a search hit, which carries none. */
  updatedMs: number;
  /** The layer name of a search hit (`#marketing`). Null for the Company list. */
  layer: string | null;
}

/** One page, open for reading. */
export interface MemoryPageDetail {
  id: string;
  title: string;
  type: string;
  body: string;
  updatedMs: number;
  /** Who last changed it: a name, an agent name, or `system`. */
  author: string;
  /** The file, a Drive path. */
  path: string;
  sourceCount: number;
}

export interface MemoryViewProps {
  rows: MemoryRow[];
  focused: boolean;
  width: number;
  height: number;
  /** The clock the age column renders against. A prop, never `Date.now()`. */
  now: number;
  loading: boolean;
  errorMessage: string | null;
  /** The page type the list is filtered to. Null shows every type. */
  typeFilter?: string | null;
  /** Types `t` cycles through, after "all". */
  typeOptions?: readonly string[];
  /** True while a search request is in flight. */
  searching?: boolean;
  /** The open page, or null while it loads or fails. */
  page: MemoryPageDetail | null;
  pageLoading?: boolean;
  pageError?: string | null;
  onQueryChange(query: string): void;
  onTypeFilter(type: string | null): void;
  /** `null` closes the page. The host fetches the page for a non-null id. */
  onOpenPage(pageId: string | null): void;
  onOpenWeb(): void;
  onRefresh(): void;
  /** Esc with nothing open and no query. */
  onBack(): void;
}

/** Width of the type column: `workstreams` + a gap. */
const TYPE_WIDTH = 12;
/** Rows the read mode's header and footer take. */
const READ_CHROME_ROWS = 4;

/** The shortest query the search route accepts. */
export const MIN_QUERY = 2;

/**
 * One list row as plain text, cursor gutter excluded.
 *
 * `<type> <title> · <summary>   <layer · age>`. The type column drops out below
 * 60 columns so the title keeps its room.
 */
export function memoryRowText(row: MemoryRow, now: number, width: number): string {
  const age = relativeAge(row.updatedMs, now);
  const right = [row.layer && row.layer !== 'Company' ? row.layer : '', age]
    .filter(Boolean)
    .join(' · ');
  const tag = width >= 60 ? `${row.type.padEnd(TYPE_WIDTH, ' ')}` : '';
  const text = row.summary ? `${row.title} · ${row.summary}` : row.title;
  return layoutRow(`${tag}${text}`, right, Math.max(width - 1, 0));
}

export function MemoryView({
  rows,
  focused,
  width,
  height,
  now,
  loading,
  errorMessage,
  typeFilter = null,
  typeOptions = [],
  searching = false,
  page,
  pageLoading = false,
  pageError = null,
  onQueryChange,
  onTypeFilter,
  onOpenPage,
  onOpenWeb,
  onRefresh,
  onBack,
}: MemoryViewProps) {
  const [mode, setMode] = useState<'browse' | 'search' | 'read'>('browse');
  const [query, setQuery] = useState('');
  const [cursorId, setCursorId] = useState<string | null>(rows[0]?.id ?? null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);

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

  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next);
      onQueryChange(next);
    },
    [onQueryChange],
  );

  const cycleType = useCallback(() => {
    if (typeOptions.length === 0) return;
    const at = typeFilter ? typeOptions.indexOf(typeFilter) : -1;
    onTypeFilter(at + 1 >= typeOptions.length ? null : (typeOptions[at + 1] ?? null));
  }, [typeFilter, typeOptions, onTypeFilter]);

  const pageSize = Math.max(height - READ_CHROME_ROWS - 1, 1);

  useKeyboard((key) => {
    if (!focused) return;

    if (mode === 'read') {
      if (matchesMemoryBinding(key, 'back')) {
        setMode('browse');
        onOpenPage(null);
        return;
      }
      if (matchesMemoryBinding(key, 'down')) return scrollRef.current?.scrollBy(1);
      if (matchesMemoryBinding(key, 'up')) return scrollRef.current?.scrollBy(-1);
      if (matchesMemoryBinding(key, 'pageDown')) return scrollRef.current?.scrollBy(pageSize);
      if (matchesMemoryBinding(key, 'pageUp')) return scrollRef.current?.scrollBy(-pageSize);
      if (matchesMemoryBinding(key, 'first')) return scrollRef.current?.scrollTo(0);
      if (matchesMemoryBinding(key, 'open')) return onOpenWeb();
      return;
    }

    if (mode === 'search') {
      if (matchesMemoryBinding(key, 'back')) {
        changeQuery('');
        setMode('browse');
        return;
      }
      if (key.name === 'return' || key.name === 'down') {
        setMode('browse');
        return;
      }
      const next = editText(query, key);
      if (next !== null) changeQuery(next);
      return;
    }

    if (matchesMemoryBinding(key, 'back')) {
      if (query) return changeQuery('');
      return onBack();
    }
    if (matchesMemoryBinding(key, 'down')) return moveTo(cursorIndex + 1);
    if (matchesMemoryBinding(key, 'up')) return moveTo(cursorIndex - 1);
    if (matchesMemoryBinding(key, 'first')) return moveTo(0);
    if (matchesMemoryBinding(key, 'last')) return moveTo(rows.length - 1);
    if (matchesMemoryBinding(key, 'search')) return setMode('search');
    if (matchesMemoryBinding(key, 'type')) return cycleType();
    if (matchesMemoryBinding(key, 'refresh')) return onRefresh();
    if (matchesMemoryBinding(key, 'open')) return onOpenWeb();
    if (matchesMemoryBinding(key, 'read') && current) {
      setMode('read');
      onOpenPage(current.id);
    }
  });

  const bodyWidth = Math.max(width - 1, 0);

  if (mode === 'read') {
    const age = page ? relativeAge(page.updatedMs, now) : '';
    return (
      <box flexDirection="column" width={width} height={height} overflow="hidden">
        <text flexShrink={0} fg={theme.fg}>
          {layoutRow(page?.title ?? current?.title ?? '', page?.type ?? '', bodyWidth)}
        </text>
        <text flexShrink={0} fg={theme.dim}>
          {page
            ? layoutRow(
                `${page.author}${age ? ` · ${age} ago` : ''}${page.sourceCount > 0 ? ` · ${page.sourceCount} sources` : ''}`,
                page.path,
                bodyWidth,
              )
            : ' '}
        </text>
        <text flexShrink={0} fg={theme.border}>{'─'.repeat(bodyWidth)}</text>
        {pageLoading && !page ? <Spinner label="loading page" /> : null}
        {pageError ? <text flexShrink={0} fg={theme.danger}>{layoutRow(pageError, '', bodyWidth)}</text> : null}
        {page ? (
          <scrollbox
            ref={scrollRef}
            focused={focused}
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            contentOptions={{ flexDirection: 'column' }}
          >
            {page.body.trim() ? (
              <TextPart text={page.body} streaming={false} width={bodyWidth} />
            ) : (
              <text flexShrink={0} fg={theme.faint}>This page has no body.</text>
            )}
          </scrollbox>
        ) : null}
        <text flexShrink={0} fg={theme.faint}>j/k scroll · Space page · g top · o open in browser · Esc back</text>
      </box>
    );
  }

  const validQuery = query.trim().length >= MIN_QUERY;
  const rowsAvailable = Math.max(height - 3, 1);
  const start = windowStart(cursorIndex, rows.length, rowsAvailable);
  const visible = rows.slice(start, start + rowsAvailable);
  const scopeText = [validQuery ? 'search' : 'Company memory', typeFilter ?? ''].filter(Boolean);
  const hints = [
    'Enter read',
    '/ search',
    typeOptions.length > 0 ? 't type' : null,
    'o browser',
    'r refresh',
    'Esc back',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <box flexDirection="column" width={width} height={height} overflow="hidden">
      <text fg={mode === 'search' || query ? theme.fg : theme.faint}>
        {mode === 'search' || query
          ? `/ ${query}${mode === 'search' ? '▏' : ''}`
          : layoutRow(scopeText.join(' · '), `${rows.length} pages`, bodyWidth)}
      </text>
      <text fg={theme.border}>{'─'.repeat(bodyWidth)}</text>

      {visible.map((row) => {
        const isCursor = row.id === current?.id;
        return (
          <text
            key={row.id}
            fg={isCursor ? theme.fg : theme.dim}
            bg={isCursor ? theme.surface : undefined}
          >
            <span fg={theme.brand}>{isCursor && focused ? GLYPH.selected : ' '}</span>
            {memoryRowText(row, now, width)}
          </text>
        );
      })}

      {(loading || searching) && rows.length === 0 ? <Spinner label="loading pages" /> : null}
      {!loading && !searching && !errorMessage && rows.length === 0 ? (
        <text fg={theme.faint}>
          {query && !validQuery
            ? `Type ${MIN_QUERY} or more characters to search.`
            : validQuery
              ? 'No page matches.'
              : 'No memory pages yet. Agents and people add them as they work.'}
        </text>
      ) : null}
      {errorMessage ? <text fg={theme.danger}>{layoutRow(errorMessage, '', bodyWidth)}</text> : null}
      {rows.length > 0 || query ? <text fg={theme.faint}>{hints}</text> : null}
    </box>
  );
}
