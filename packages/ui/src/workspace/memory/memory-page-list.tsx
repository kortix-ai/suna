'use client';

import type { ProjectMemoryPageSummary, ProjectMemoryPageType } from '@kortix/sdk';
import { useProjectMemoryPages, useProjectMemorySearch } from '@kortix/sdk/react';
import { CaretRightIcon, MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { useDebounce } from '../../internal/hooks/use-debounced-value';
import { uiRoutes } from '../../lib/routes';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '../../primitives/disclosure';
import { ErrorState } from '../../primitives/error-state';
import Loading from '../../primitives/loading';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { UiLink } from '../../providers/ui-provider';

/** The layer's pages, newest updated first. */
export function sortMemoryPages(pages: readonly ProjectMemoryPageSummary[]): ProjectMemoryPageSummary[] {
  return [...pages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

/** The list's groups, in this order. Empty groups are not shown. */
const MEMORY_GROUP_ORDER: readonly ProjectMemoryPageType[] = [
  'other',
  'people',
  'decisions',
  'workstreams',
  'playbooks',
  'note',
];

/** Sorted pages split into their type's group, in `MEMORY_GROUP_ORDER`, without empty groups. */
export function groupMemoryPages(
  pages: readonly ProjectMemoryPageSummary[],
): { type: ProjectMemoryPageType; pages: ProjectMemoryPageSummary[] }[] {
  return MEMORY_GROUP_ORDER.map((type) => ({ type, pages: pages.filter((page) => page.type === type) })).filter(
    (group) => group.pages.length > 0,
  );
}

/** The collapsed groups of one layer, per viewer. Storage can be absent or throw: then every group starts open. */
function readCollapsed(key: string): ProjectMemoryPageType[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value.filter((type): type is ProjectMemoryPageType => typeof type === 'string') : [];
  } catch {
    return [];
  }
}

function writeCollapsed(key: string, collapsed: readonly ProjectMemoryPageType[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(collapsed));
  } catch {
    // Private mode or blocked storage: the state lasts until reload.
  }
}

/** Collapsed groups, remembered per project and layer; the selected page's group opens when it is collapsed. */
function useCollapsedGroups(
  projectId: string,
  layerKey: string,
  selected: { id: string; type: ProjectMemoryPageType } | null,
) {
  const key = `kortix:memory-groups-collapsed:${projectId}:${layerKey}`;
  const [state, setState] = useState(() => ({ key, collapsed: readCollapsed(key) }));
  let collapsed = state.key === key ? state.collapsed : readCollapsed(key);
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if ((selected?.id ?? null) !== openedFor) {
    // Adjusting state during render: a page chosen elsewhere (a link, the palette) shows inside an open group.
    setOpenedFor(selected?.id ?? null);
    if (selected && collapsed.includes(selected.type)) collapsed = collapsed.filter((type) => type !== selected.type);
  }
  if (state.key !== key || state.collapsed !== collapsed) setState({ key, collapsed });
  // A toggle and an auto-open both persist, so a reload shows what the viewer last saw.
  useEffect(() => writeCollapsed(state.key, state.collapsed), [state]);
  const toggle = (type: ProjectMemoryPageType) => {
    setState({ key, collapsed: collapsed.includes(type) ? collapsed.filter((item) => item !== type) : [...collapsed, type] });
  };
  return { collapsed, toggle };
}

const ROW =
  'focus-visible:ring-ring flex h-8 w-full shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2';

/**
 * The Memory tab's middle column: "5 pages" with a search button (it turns
 * the header into a search field), "All" (the layer at a glance), then the
 * page titles in groups by type
 * (About, People, Decisions, Projects, How we work, Notes), newest first in
 * each. A search of 2 characters or more shows the server's hits as one
 * flat list.
 */
export function MemoryPageList({
  projectId,
  layerKey,
  pages,
  selectedId,
  onSelect,
  anchor,
  className,
}: {
  projectId: string;
  layerKey: string;
  /** Sorted by `sortMemoryPages`. */
  pages: readonly ProjectMemoryPageSummary[];
  /** null: the All view. */
  selectedId: string | null;
  /** null: the All view. */
  onSelect: (pageId: string | null) => void;
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
  const groups = useMemo(() => groupMemoryPages(shown), [shown]);
  const selectedPage = pages.find((page) => page.page_id === selectedId);
  const { collapsed, toggle } = useCollapsedGroups(
    projectId,
    layerKey,
    selectedPage ? { id: selectedPage.page_id, type: selectedPage.type } : null,
  );
  const closeSearch = () => {
    setQuery('');
    setSearchOpen(false);
  };

  // One box in both states (the rows' height, `mb-1.5` above the first group), so opening search moves nothing below.
  const headerBox = 'mb-1.5 flex h-8 shrink-0 items-center';
  const header = searchOpen ? (
    <div className={headerBox}>
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
    <div className={cn(headerBox, 'justify-between pr-1 pl-2')}>
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
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {needle ? null : (
            <button
              type="button"
              aria-current={selectedId === null ? 'page' : undefined}
              onClick={() => onSelect(null)}
              className={cn(
                ROW,
                selectedId === null
                  ? 'bg-active text-foreground font-medium'
                  : 'text-muted-foreground hover:bg-hover hover:text-foreground transition-colors duration-fast',
              )}
            >
              {t('all.title')}
            </button>
          )}
          {groups.map((group) => (
            <MemoryPageGroup
              key={group.type}
              label={t(`group.${group.type}`)}
              open={!collapsed.includes(group.type)}
              onToggle={() => toggle(group.type)}
            >
              {group.pages.map((page) => (
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
            </MemoryPageGroup>
          ))}
          {needle && shown.length === 0 ? (
            <p className="text-muted-foreground px-2 py-8 text-xs">{t('noMatches', { query: trimmed })}</p>
          ) : null}
        </div>
      )}
      {layerKey === 'company' ? null : <CompanyMemoryLink projectId={projectId} />}
    </nav>
  );
}

/**
 * One type's pages under a ghost header row: the muted label on the page
 * titles' text edge (same `h-8 px-2 rounded-md` box as the rows), the caret
 * at the far right, pointing down while open. Hover fills it with
 * `bg-secondary`. Height and opacity fold in 200ms ease-out; with reduced
 * motion the height snaps and only the fade stays.
 */
function MemoryPageGroup({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  return (
    <Disclosure
      open={open}
      onOpenChange={onToggle}
      className="group/memory-group flex shrink-0 flex-col gap-px"
      transition={{ duration: 0.2, ease: 'easeOut', ...(reduceMotion ? { height: { duration: 0 } } : null) }}
    >
      <DisclosureTrigger>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-ring duration-fast h-8 w-full justify-between gap-2 px-2 text-left text-xs font-normal transition-colors focus-visible:ring-2 has-[>svg]:px-2"
        >
          <span className="min-w-0 truncate">{label}</span>
          <CaretRightIcon
            aria-hidden
            className="duration-moderate size-3.5 shrink-0 transition-[rotate] ease-out group-data-[state=open]/memory-group:rotate-90 motion-reduce:transition-none"
          />
        </Button>
      </DisclosureTrigger>
      <DisclosureContent>
        <ul className="flex flex-col">{children}</ul>
      </DisclosureContent>
    </Disclosure>
  );
}

/** A channel's or DM's list ends with the Company memory its agent also reads; hidden until its count loads. */
export function CompanyMemoryLink({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.memory');
  const company = useProjectMemoryPages(projectId, 'company');
  const href = uiRoutes().memory(projectId);
  if (!href || !company.data) return null;
  return (
    <UiLink
      href={href}
      title={t('companyLinkHint')}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-3 shrink-0 truncate rounded-md px-2 text-xs tabular-nums outline-none transition-colors duration-fast focus-visible:ring-2"
    >
      {t('companyLink', { count: company.data.length })}
    </UiLink>
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
