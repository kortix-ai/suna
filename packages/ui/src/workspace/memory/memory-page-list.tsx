'use client';

import type { ProjectMemoryPage, ProjectMemoryPageSummary } from '@kortix/sdk';
import { useProjectMemorySearch } from '@kortix/sdk/react';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { type ReactElement, type ReactNode, useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { useDebounce } from '../../internal/hooks/use-debounced-value';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import Loading from '../../primitives/loading';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';

/** The layer's pages, newest updated first. */
export function sortMemoryPages(pages: readonly ProjectMemoryPageSummary[]): ProjectMemoryPageSummary[] {
  return [...pages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

const ROW =
  'focus-visible:ring-ring flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2';

/**
 * The Memory tab's middle column: "5 pages" with a search button (it turns
 * the header into a search field), one flat list of page titles (newest
 * first), and at the bottom a small graph of the open page and its related pages.
 */
export function MemoryPageList({
  projectId,
  layerKey,
  pages,
  selectedId,
  related,
  onSelect,
  anchor,
  className,
}: {
  projectId: string;
  layerKey: string;
  /** Sorted by `sortMemoryPages`. */
  pages: readonly ProjectMemoryPageSummary[];
  selectedId: string | null;
  /** The open page's related pages, once the page has loaded: the graph. */
  related: ProjectMemoryPage['related'] | undefined;
  onSelect: (pageId: string) => void;
  /** Wraps the header row: "Remember this…" anchors to it when a link opens it. */
  anchor?: (header: ReactElement) => ReactNode;
  className?: string;
}) {
  const t = useTranslations('spaces.memory');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 2 characters or more: the server's search (titles, summaries and text).
  // 1 character: the titles, filtered here.
  const trimmed = query.trim();
  const searching = trimmed.length >= 2;
  const debounced = useDebounce(trimmed, 250);
  const search = useProjectMemorySearch(projectId, { q: debounced, layer: layerKey }, { enabled: searching });
  const needle = searching ? '' : trimmed.toLowerCase();
  const shown = useMemo(
    () => (needle ? pages.filter((page) => page.title.toLowerCase().includes(needle)) : pages),
    [pages, needle],
  );
  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };

  const header = searchOpen ? (
    <div className="mb-1 flex h-7.5 shrink-0 items-center">
      <InputGroupSearch className="flex-1">
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          size="xs"
          autoFocus
          placeholder={t('search')}
          aria-label={t('search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onBlur={() => !query && setSearchOpen(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeSearch();
            }
          }}
        />
        <InputGroupSearchClear onClick={closeSearch} />
      </InputGroupSearch>
    </div>
  ) : (
    <div className="mb-1 flex h-7.5 shrink-0 items-center justify-between pr-1 pl-2">
      <p className="text-muted-foreground text-xs tabular-nums">{t('pageCount', { count: pages.length })}</p>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('search')}
        className="text-muted-foreground hover:text-foreground"
        onClick={() => setSearchOpen(true)}
      >
        <MagnifyingGlassIcon className="size-3.5" />
      </Button>
    </div>
  );

  return (
    <nav aria-label={t('pagesLabel')} className={cn('flex w-72 shrink-0 flex-col border-r px-3.5 pt-5 pb-4', className)}>
      {anchor ? anchor(header) : header}
      {searching ? (
        <SearchResults query={trimmed} search={search} ready={debounced.length >= 2} selectedId={selectedId} onSelect={onSelect} />
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {shown.map((page) => (
            <li key={page.page_id}>
              <button
                type="button"
                aria-current={page.page_id === selectedId ? 'page' : undefined}
                onClick={() => onSelect(page.page_id)}
                title={page.title}
                className={cn(
                  ROW,
                  page.page_id === selectedId
                    ? 'bg-active text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-hover hover:text-foreground transition-colors duration-fast',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{page.title}</span>
              </button>
            </li>
          ))}
          {needle && shown.length === 0 ? (
            <li className="text-muted-foreground px-2 py-8 text-xs">{t('noMatches', { query: trimmed })}</li>
          ) : null}
        </ul>
      )}
      {related && related.length > 0 && !searching ? (
        <MemoryGraph related={related} onSelect={onSelect} label={t('relatedPages')} />
      ) : null}
    </nav>
  );
}

/** Where the related pages sit around the open page (the centre, 120 × 75), in a 240 × 150 box. */
const SLOTS: readonly [number, number][] = [
  [60, 40],
  [186, 48],
  [78, 118],
  [170, 112],
  [28, 84],
  [212, 84],
  [122, 20],
  [124, 132],
  [26, 26],
  [214, 132],
];

/**
 * The open page (the dark centre dot) and its related pages, a line to each.
 * Static: no physics. A dot opens its page.
 */
function MemoryGraph({
  related,
  onSelect,
  label,
}: {
  related: ProjectMemoryPage['related'];
  onSelect: (pageId: string) => void;
  label: string;
}) {
  const nodes = related.slice(0, SLOTS.length).map((page, i) => ({ ...page, at: SLOTS[i]! }));
  return (
    <svg viewBox="0 0 240 150" role="group" aria-label={label} className="mt-4 aspect-[8/5] w-full shrink-0">
      {nodes.map(({ page_id, at: [x, y] }) => (
        <line key={page_id} x1={120} y1={75} x2={x} y2={y} className="stroke-border" strokeWidth={1} />
      ))}
      <circle cx={120} cy={75} r={6} className="fill-foreground" />
      {nodes.map(({ page_id, title, at: [x, y] }) => (
        <g
          key={page_id}
          role="link"
          tabIndex={0}
          aria-label={title}
          className="group cursor-pointer outline-none"
          onClick={() => onSelect(page_id)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onSelect(page_id);
            }
          }}
        >
          <title>{title}</title>
          {/* The hit area: the dot is 8px, the target 20px. */}
          <circle cx={x} cy={y} r={10} className="fill-transparent" />
          <circle
            cx={x}
            cy={y}
            r={4}
            className="fill-muted-foreground/60 group-hover:fill-foreground group-focus-visible:fill-foreground transition-colors duration-fast"
          />
        </g>
      ))}
    </svg>
  );
}

/**
 * The server's hits for the search field, best first: title and summary. The
 * hits of the previous query stay while the next one loads.
 */
function SearchResults({
  query,
  search,
  ready,
  selectedId,
  onSelect,
}: {
  query: string;
  search: ReturnType<typeof useProjectMemorySearch>;
  /** The debounced query has 2 characters: until then the hits are of no query of this field. */
  ready: boolean;
  selectedId: string | null;
  onSelect: (pageId: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  const hits = ready ? search.data?.hits : undefined;
  let body: ReactNode;
  if (search.isError && !hits) {
    body = (
      <ErrorState
        size="sm"
        title={t('searchError')}
        action={
          <Button variant="outline" size="sm" onClick={() => search.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (!hits) {
    body = (
      <div className="flex justify-center py-8">
        <Loading className="size-4 shrink-0" />
      </div>
    );
  } else if (hits.length === 0) {
    body = <p className="text-muted-foreground px-2 py-8 text-xs">{t('noMatches', { query })}</p>;
  } else {
    body = (
      <ul aria-label={t('searchResults')} className="flex flex-col">
        {hits.map((hit) => (
          <li key={hit.page_id}>
            <button
              type="button"
              aria-current={hit.page_id === selectedId ? 'page' : undefined}
              onClick={() => onSelect(hit.page_id)}
              className={cn(
                'focus-visible:ring-ring flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2',
                hit.page_id === selectedId ? 'bg-active' : 'hover:bg-hover',
              )}
            >
              <span className="text-foreground truncate font-medium">{hit.title}</span>
              {hit.summary || hit.snippet ? (
                <span className="text-muted-foreground line-clamp-2 text-xs">{hit.summary || hit.snippet}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>;
}
