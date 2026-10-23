'use client';

import type { ProjectMemoryChange, ProjectMemoryPageSummary, ProjectMemoryPageType } from '@kortix/sdk';
import { useProjectMemoryChanges } from '@kortix/sdk/react';
import { CaretDownIcon, ClockCounterClockwiseIcon, FileTextIcon, MagnifyingGlassIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { type ReactNode, useMemo, useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { ErrorState } from '../../primitives/error-state';
import Loading from '../../primitives/loading';
import Hint from '../../primitives/hint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { MEMORY_GROUPS, MEMORY_TYPE_ICON, MemoryAuthorAvatar, useMemoryAuthorName } from './memory-labels';
import { useUndoMemoryChange } from './memory-recent-change';

/** The layer's confirmed pages by type, newest first; unconfirmed pages wait under "Needs confirming". */
export function groupMemoryPages(pages: readonly ProjectMemoryPageSummary[]) {
  const groups = new Map<ProjectMemoryPageType, ProjectMemoryPageSummary[]>(MEMORY_GROUPS.map((type) => [type, []]));
  const unconfirmed: ProjectMemoryPageSummary[] = [];
  const sorted = [...pages].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  for (const page of sorted) {
    if (page.status === 'unconfirmed') unconfirmed.push(page);
    else groups.get(page.type)?.push(page);
  }
  return { groups, unconfirmed };
}

const ROW = 'focus-visible:ring-ring flex h-7.5 w-full shrink-0 items-center rounded-md text-left text-xs outline-none focus-visible:ring-2';

/**
 * The Memory tab's left column: search, "All pages", the 4 type groups
 * (collapsible, with counts), Notes when there are some, and "Needs
 * confirming" pinned at the bottom when an agent saved outside content.
 */
export function MemoryPageList({
  projectId,
  layerKey,
  pages,
  total,
  selectedId,
  onSelect,
  onViewChange,
  className,
}: {
  projectId: string;
  layerKey: string;
  pages: readonly ProjectMemoryPageSummary[];
  /** "All pages": the layer's pages without notes, the number the tab shows (`memoryPageCount`). */
  total: number;
  selectedId: string | null;
  onSelect: (pageId: string) => void;
  /** A Recent changes row's View: the page, at that version. */
  onViewChange: (pageId: string, versionId: string) => void;
  className?: string;
}) {
  const t = useTranslations('spaces.memory');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<ProjectMemoryPageType>>(new Set());
  const { groups, unconfirmed } = useMemo(() => groupMemoryPages(pages), [pages]);
  const needle = query.trim().toLowerCase();
  const visible = MEMORY_GROUPS.map((type) => {
    const all = groups.get(type)!;
    return { type, all, shown: needle ? all.filter((page) => page.title.toLowerCase().includes(needle)) : all };
  }).filter(({ type, all, shown }) => (needle ? shown.length > 0 : type !== 'note' || all.length > 0));

  const toggle = (type: ProjectMemoryPageType) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(type)) next.add(type);
      return next;
    });

  return (
    <nav aria-label={t('pagesLabel')} className={cn('flex w-72 shrink-0 flex-col border-r', className)}>
      <div className="flex shrink-0 items-center gap-1.5 px-3 pt-4 pb-2.5">
        <InputGroupSearch className="flex-1">
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            size="xs"
            placeholder={t('search')}
            aria-label={t('search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query ? <InputGroupSearchClear onClick={() => setQuery('')} /> : null}
        </InputGroupSearch>
        <RecentChanges projectId={projectId} layerKey={layerKey} onView={onViewChange} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3 pb-4">
        <div className={cn(ROW, 'text-foreground gap-2 px-2')}>
          <span className="flex w-4 shrink-0 justify-center">
            <FileTextIcon aria-hidden className="text-muted-foreground size-3.5" />
          </span>
          <span className="flex-1 truncate">{t('allPages')}</span>
          {total > 0 ? <CountBadge count={total} /> : null}
        </div>
        {visible.map(({ type, all, shown }) => {
          const Glyph = MEMORY_TYPE_ICON[type];
          const open = needle ? true : !collapsed.has(type);
          return (
            <div key={type} className="flex flex-col gap-0.5 pt-2.5">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggle(type)}
                disabled={!!needle}
                className={cn(ROW, 'group/type text-foreground hover:bg-hover gap-2 px-2 font-medium disabled:hover:bg-transparent')}
              >
                <span className="flex w-4 shrink-0 justify-center">
                  <Glyph aria-hidden className="text-muted-foreground size-3.5 group-hover/type:hidden group-focus-visible/type:hidden group-disabled/type:block" />
                  <CaretDownIcon
                    aria-hidden
                    className={cn(
                      'text-muted-foreground hidden size-3.5 group-hover/type:block group-focus-visible/type:block group-disabled/type:hidden',
                      !open && '-rotate-90',
                    )}
                  />
                </span>
                <span className="flex-1 truncate">{t(`type.${type}`)}</span>
                {shown.length > 0 ? <CountBadge count={shown.length} /> : null}
              </button>
              {open
                ? shown.map((page) => (
                    <PageRow key={page.page_id} page={page} selected={page.page_id === selectedId} onSelect={onSelect} />
                  ))
                : null}
            </div>
          );
        })}
        {needle && visible.length === 0 ? (
          <p className="text-muted-foreground px-2 py-8 text-xs">{t('noMatches', { query: query.trim() })}</p>
        ) : null}
      </div>
      {unconfirmed.length > 0 ? (
        <div className="shrink-0 px-3 pb-4">
          <button
            type="button"
            onClick={() => onSelect(unconfirmed[0]!.page_id)}
            className={cn(ROW, 'bg-kortix-orange/15 text-foreground h-8 gap-2 px-2')}
          >
            <span className="flex w-4 shrink-0 justify-center">
              <WarningCircleIcon aria-hidden className="text-kortix-orange size-3.5" />
            </span>
            <span className="flex-1 truncate">{t('needsConfirming')}</span>
            <CountBadge count={unconfirmed.length} tone="conflict" />
          </button>
        </div>
      ) : null}
    </nav>
  );
}

function PageRow({
  page,
  selected,
  onSelect,
}: {
  page: ProjectMemoryPageSummary;
  selected: boolean;
  onSelect: (pageId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(page.page_id)}
      title={page.title}
      className={cn(
        ROW,
        'pr-2 pl-8.5',
        selected ? 'bg-active text-foreground font-medium' : 'text-muted-foreground hover:bg-hover hover:text-foreground',
      )}
    >
      <span className="truncate">{page.title}</span>
    </button>
  );
}

/** The layer's Recent changes: who changed which page, from which thread, with View and Undo. */
function RecentChanges({
  projectId,
  layerKey,
  onView,
}: {
  projectId: string;
  layerKey: string;
  onView: (pageId: string, versionId: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  const [open, setOpen] = useState(false);
  const changes = useProjectMemoryChanges(projectId, layerKey, { enabled: open });
  const rows = changes.data?.pages.flatMap((page) => page.changes) ?? [];
  let body: ReactNode = null;
  if (changes.isError && !changes.data) {
    body = (
      <ErrorState
        size="sm"
        title={t('changes.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => changes.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (!changes.data) {
    body = (
      <div className="flex justify-center py-8">
        <Loading className="size-4 shrink-0" />
      </div>
    );
  } else if (rows.length === 0) {
    body = <p className="text-muted-foreground px-2 py-8 text-center text-xs">{t('changes.empty')}</p>;
  } else if (rows.length > 0) {
    body = (
      <ol className="flex flex-col gap-0.5">
        {rows.map((change) => (
          <ChangeRow
            key={change.version_id}
            projectId={projectId}
            change={change}
            onView={() => {
              setOpen(false);
              onView(change.page_id, change.version_id);
            }}
          />
        ))}
      </ol>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint label={t('changes.title')} side="bottom">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('changes.title')} className="text-muted-foreground shrink-0">
            <ClockCounterClockwiseIcon className="size-4" />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="flex max-h-120 w-96 flex-col gap-1 p-1.5">
        <p className="text-muted-foreground px-2 pt-1 pb-1 text-xs font-medium">{t('changes.title')}</p>
        <div className="min-h-0 overflow-y-auto">
          {body}
          {changes.hasNextPage ? (
            <Button
              variant="ghost"
              size="toolbar"
              className="text-muted-foreground mt-1 w-full"
              disabled={changes.isFetchingNextPage}
              aria-busy={changes.isFetchingNextPage || undefined}
              onClick={() => changes.fetchNextPage()}
            >
              {t('loadOlder')}
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ChangeRow({ projectId, change, onView }: { projectId: string; change: ProjectMemoryChange; onView: () => void }) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  const authorName = useMemoryAuthorName();
  const undo = useUndoMemoryChange(projectId);
  const name = authorName(change.author);
  const meta = [
    change.source ? t('fromThread', { thread: change.source.label }) : null,
    relativeTime(change.created_at, locale),
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-2.5 rounded-md px-2 py-2">
      <MemoryAuthorAvatar author={change.author} name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-xs [overflow-wrap:anywhere]">
          {t.rich(`changes.op.${change.op}`, {
            author: name,
            title: change.page_title,
            page: (chunks) => <span className="font-medium">{chunks}</span>,
          })}
        </p>
        <p className="text-muted-foreground truncate text-xs">{meta.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {change.op !== 'delete' || change.undone ? (
          <Button
            variant="ghost"
            size="toolbar"
            className="text-muted-foreground"
            aria-label={t('changes.viewPage', { title: change.page_title })}
            onClick={onView}
          >
            {t('view')}
          </Button>
        ) : null}
        {change.undone ? (
          <span className="text-muted-foreground px-2 text-xs">{t('history.undone')}</span>
        ) : change.can_undo ? (
          <Button
            variant="ghost"
            size="toolbar"
            disabled={undo.isPending}
            aria-busy={undo.isPending || undefined}
            aria-label={t('changes.undoPage', { title: change.page_title })}
            onClick={() => undo.run(change.version_id)}
          >
            {t('undo')}
          </Button>
        ) : (
          <Hint label={t('undoUnavailable')} side="top">
            {/* A disabled button gets no pointer events: the span carries the hint. */}
            <span tabIndex={0} className="focus-visible:ring-ring rounded-md outline-none focus-visible:ring-2">
              <Button variant="ghost" size="toolbar" disabled>
                {t('undo')}
              </Button>
            </span>
          </Hint>
        )}
      </div>
    </li>
  );
}
