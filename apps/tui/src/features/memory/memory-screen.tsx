/**
 * The Memory screen: the project's Company memory pages.
 *
 * This file is the data half — every read is a `@kortix/sdk/react` hook. It
 * renders `<MemoryView/>`, which owns pixels and keys and knows nothing about
 * the SDK. Memory is read-only here: the TUI lists, searches and reads pages;
 * people and agents write them.
 *
 * The web gates the page on the project's `project_channels` flag
 * (`apps/web/.../projects/[id]/memory/page.tsx`); this screen reads the same
 * flag through `useFeatureFlag`. Every memory route also answers 403
 * `feature_disabled` while Files (`drives`) are off — that status reaches the
 * view as the error line.
 */

import type {
  ProjectMemoryAuthor,
  ProjectMemoryPage,
  ProjectMemoryPageSummary,
  ProjectMemorySearchHit,
} from '@kortix/sdk';
import {
  useFeatureFlag,
  useProjectMemoryPage,
  useProjectMemoryPages,
  useProjectMemorySearch,
} from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { Spinner } from '../../ui/index.ts';
import {
  MIN_QUERY,
  type MemoryPageDetail,
  type MemoryRow,
  MemoryView,
} from './memory-view.tsx';

export interface MemoryScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  /** Inner columns. */
  width: number;
  /** Inner rows. */
  height: number;
  /** Kortix web origin, for "open in browser". */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** Test seam for `o`. Defaults to `lib/open-url.ts`. */
  openUrlImpl?: (url: string) => Promise<unknown>;
}

/** The layer this screen lists. Channel and DM layers stay in their Spaces. */
export const COMPANY_LAYER = 'company';

/** `t` cycles through these, after "all". */
export const PAGE_TYPES = [
  'people',
  'decisions',
  'workstreams',
  'playbooks',
  'note',
  'other',
] as const;

/** Wait this long after the last keystroke before one search request. */
export const SEARCH_DEBOUNCE_MS = 300;

/** How often the age column is recomputed. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Unknown error';
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
}

function epochMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/** `updated_by` as a name: the person, else the agent, else `system`. */
export function authorName(author: ProjectMemoryAuthor): string {
  return author.name || author.agent || author.kind;
}

export function pageRow(page: ProjectMemoryPageSummary): MemoryRow {
  return {
    id: page.page_id,
    title: page.title,
    type: page.type,
    summary: page.summary,
    updatedMs: epochMs(page.updated_at),
    layer: null,
  };
}

/** A hit has a snippet around the match instead of a summary, and no stamp. */
export function hitRow(hit: ProjectMemorySearchHit): MemoryRow {
  return {
    id: hit.page_id,
    title: hit.title,
    type: hit.type,
    summary: hit.snippet || hit.summary,
    updatedMs: Number.NaN,
    layer: hit.layer_name,
  };
}

export function pageDetail(page: ProjectMemoryPage): MemoryPageDetail {
  return {
    id: page.page_id,
    title: page.title,
    type: page.type,
    body: page.body,
    updatedMs: epochMs(page.updated_at),
    author: authorName(page.updated_by),
    path: page.path,
    sourceCount: page.sources.length,
  };
}

/** The web route for this screen. The page id is not a route: the list opens. */
export function memoryWebUrl(webBaseUrl: string, projectId: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/projects/${projectId}/memory`;
}

export function MemoryScreen({
  projectId,
  accountId: _accountId,
  sessionId: _sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession: _onOpenSession,
  onToast,
  openUrlImpl = openUrl,
}: MemoryScreenProps) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const flag = useFeatureFlag(projectId, 'project_channels');
  const enabled = flag.enabled;
  const searchActive = debounced.length >= MIN_QUERY && query.trim().length >= MIN_QUERY;

  const pagesQuery = useProjectMemoryPages(projectId, COMPANY_LAYER, {
    enabled,
    type: (typeFilter as ProjectMemoryPageSummary['type'] | null) ?? undefined,
  });
  const searchQuery = useProjectMemorySearch(
    projectId,
    {
      q: debounced,
      type: (typeFilter as ProjectMemoryPageSummary['type'] | null) ?? undefined,
    },
    { enabled: enabled && searchActive },
  );
  const pageQuery = useProjectMemoryPage(projectId, pageId, { enabled });

  const rows = useMemo<MemoryRow[]>(() => {
    if (searchActive) return (searchQuery.data?.hits ?? []).map(hitRow);
    return (pagesQuery.data ?? []).map(pageRow);
  }, [searchActive, searchQuery.data, pagesQuery.data]);

  const page = useMemo(
    () => (pageQuery.data && pageQuery.data.page_id === pageId ? pageDetail(pageQuery.data) : null),
    [pageQuery.data, pageId],
  );

  const openWeb = useCallback(() => {
    if (!projectId) return;
    const url = memoryWebUrl(webBaseUrl, projectId);
    void openUrlImpl(url)
      .then(() => onToast(`Opened ${url}`))
      .catch((error: unknown) => onToast(errorText(error), 'error'));
  }, [projectId, webBaseUrl, openUrlImpl, onToast]);

  const refresh = useCallback(() => {
    void (searchActive ? searchQuery.refetch() : pagesQuery.refetch()).catch((error: unknown) =>
      onToast(errorText(error), 'error'),
    );
  }, [searchActive, searchQuery.refetch, pagesQuery.refetch, onToast]);

  if (!projectId) {
    return <text fg={theme.faint}>No project selected.</text>;
  }
  if (flag.isLoading) return <Spinner label="checking Memory" />;
  if (!enabled) {
    return (
      <text fg={theme.faint}>
        Memory is off: the project's Channels feature (project_channels) is not enabled.
      </text>
    );
  }

  const listError = searchActive ? searchQuery.error : pagesQuery.error;
  return (
    <MemoryView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={searchActive ? searchQuery.isLoading : pagesQuery.isLoading}
      searching={searchActive && searchQuery.isFetching}
      errorMessage={listError ? errorText(listError) : null}
      typeFilter={typeFilter}
      typeOptions={PAGE_TYPES}
      page={page}
      pageLoading={pageQuery.isLoading}
      pageError={pageQuery.isError ? errorText(pageQuery.error) : null}
      onQueryChange={setQuery}
      onTypeFilter={setTypeFilter}
      onOpenPage={setPageId}
      onOpenWeb={openWeb}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
