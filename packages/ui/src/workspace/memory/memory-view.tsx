'use client';

import { useProjectMemoryLayer, useProjectMemoryPage, useProjectMemoryPages } from '@kortix/sdk/react';
import { SunDimIcon } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { SplitSheet, SplitSheetMain } from '../../primitives/split-sheet';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { MemoryEmpty } from './memory-empty';
import { MemoryAll, MemoryAllSkeleton } from './memory-all';
import { MemoryHistory } from './memory-history';
import { MemoryPageList, sortMemoryPages } from './memory-page-list';
import { MemoryReader, MemoryReaderSkeleton } from './memory-reader';
import { RememberPopover } from './remember-popover';

/** The open page, in the URL so a page can be linked (the thread's "Saved to memory · View" uses it). */
export const MEMORY_PAGE_PARAM = 'page';
/** Set with `page`: the page opens with its History beside it. */
export const MEMORY_HISTORY_PARAM = 'history';
/** `1`: "Remember this…" opens on arrival (#general's "Get started"); the view then drops it. */
export const MEMORY_REMEMBER_PARAM = 'remember';

type HistoryState = { versionId: string | null; mode: 'sheet' | 'preview' | 'closed' };

export interface MemoryViewProps {
  projectId: string;
  /** `company`, or the space id of a channel or DM. */
  layerKey: string;
  /** "#marketing", the DM's agent, or "Company": the copy's name for the layer. */
  place: string;
}

/**
 * A layer's memory: the flat page list
 * on the left, the open page on the right (its History in a sheet beside
 * it; its body edited in place). A layer with no pages says what memory is
 * and offers "Remember this…". The same view serves a channel, a DM and the
 * Company page.
 */
export function MemoryView({ projectId, layerKey, place }: MemoryViewProps) {
  const t = useTranslations('spaces.memory');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const layer = useProjectMemoryLayer(projectId, layerKey);
  const list = useProjectMemoryPages(projectId, layerKey);
  // `?remember=1` opens "Remember this…" once its trigger mounts.
  const [remembering, setRemembering] = useState(() => searchParams.get(MEMORY_REMEMBER_PARAM) === '1');
  const [editing, setEditing] = useState(false);
  // Bumped by the editor's Reload: a fresh form on the newest version. Not the
  // version itself: a save bumps it too, and a remount would drop the save's
  // own onSuccess (TanStack skips call-time callbacks of an unmounted caller).
  const [editorRun, setEditorRun] = useState(0);
  // History: `versionId` is the version picked in it (null: the current page).
  // `sheet`: the sheet is open and the reader previews `versionId`.
  // `preview`: the sheet covered the reader (a narrow container), so Preview
  //   closed it; the reader shows `versionId` under its preview bar.
  // `closed`: back to the current page from `preview`; History reopens on `versionId`.
  // `?history=1` (the thread line's "open History") opens it on arrival.
  const [history, setHistory] = useState<HistoryState | null>(() =>
    searchParams.get(MEMORY_HISTORY_PARAM) ? { versionId: null, mode: 'sheet' } : null,
  );

  // A page this view just deleted (or whose creation it undid) leaves the list
  // at once, until the list refetches (an Undo may bring it back after that).
  const [gone, setGone] = useState<{ pageId: string; list: unknown } | null>(null);
  const pages = useMemo(() => {
    const all = list.data ?? [];
    return sortMemoryPages(gone && gone.list === list.data ? all.filter((page) => page.page_id !== gone.pageId) : all);
  }, [list.data, gone]);
  const requested = searchParams.get(MEMORY_PAGE_PARAM);
  const explicit = pages.find((page) => page.page_id === requested);
  // No page in the URL (or one that is gone): the All view.
  const selected = explicit;
  const page = useProjectMemoryPage(projectId, selected?.page_id);

  const setPage = (pageId: string | null) => {
    setEditing(false);
    if (pageId !== selected?.page_id) setHistory(null);
    const params = new URLSearchParams(searchParams.toString());
    if (pageId) params.set(MEMORY_PAGE_PARAM, pageId);
    else params.delete(MEMORY_PAGE_PARAM);
    params.delete(MEMORY_HISTORY_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  };

  const focusRemember = searchParams.get(MEMORY_REMEMBER_PARAM) === '1';
  const loaded = !!layer.data && !!list.data;
  useEffect(() => {
    if (!focusRemember || !loaded) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete(MEMORY_REMEMBER_PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [focusRemember, loaded, pathname, router, searchParams]);

  if ((layer.isError && !layer.data) || (list.isError && !list.data)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-16">
        <ErrorState
          size="sm"
          title={t('loadError')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void layer.refetch();
                void list.refetch();
              }}
            >
              {t('retry')}
            </Button>
          }
        />
      </div>
    );
  }
  if (!layer.data || !list.data) {
    // First load: a ghost of the list and the reader at their real line boxes, so nothing moves when the data lands.
    return (
      // Shown after 150 ms: a load faster than that draws no skeleton at all.
      <div
        aria-busy
        className="@container/memory animate-in fade-in-0 fill-mode-backwards flex min-h-0 w-full min-w-0 flex-1 delay-150 motion-reduce:animate-none"
      >
        <div
          className={cn(
            'flex w-72 shrink-0 flex-col border-r px-3.5 pt-5 pb-4 @max-md/memory:w-full',
            requested && '@max-md/memory:hidden',
          )}
        >
          <div className="mb-1.5 flex h-8 shrink-0 items-center justify-between pr-1 pl-2">
            <div className="text-xs">
              <Skeleton className="inline-block h-2.5 w-12 rounded-sm py-0 align-middle" />
            </div>
            <div className="flex size-6 items-center justify-center">
              <Skeleton className="size-3.5 rounded-sm py-0" />
            </div>
          </div>
          {['w-3/5', 'w-4/5', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/4'].map((width, index) => (
            <div key={index} className="flex h-8 shrink-0 items-center px-2 text-sm">
              <Skeleton className={cn('inline-block h-3 rounded-sm py-0', width)} />
            </div>
          ))}
        </div>
        {requested ? <MemoryReaderSkeleton /> : <MemoryAllSkeleton className="@max-md/memory:hidden" />}
      </div>
    );
  }

  const canWrite = layer.data.can_write && !layer.data.read_only;
  const kind = layer.data.scope;
  const rememberProps = {
    projectId,
    layerKey,
    place,
    open: remembering,
    onOpenChange: setRemembering,
  };

  if (pages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <MemoryEmpty
          projectId={projectId}
          kind={kind}
          place={place}
          action={
            canWrite ? (
              <RememberPopover {...rememberProps}>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <SunDimIcon className="size-3.5 shrink-0" />
                  {t('remember.open')}
                </Button>
              </RememberPopover>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="@container/memory flex min-h-0 w-full min-w-0 flex-1">
      {/* Too narrow for both: the list, until a page is opened; then the page, with a way back. */}
      <MemoryPageList
        projectId={projectId}
        layerKey={layerKey}
        pages={pages}
        selectedId={selected?.page_id ?? null}
        onSelect={setPage}
        // `?remember=1` (#general's "Get started"): "Remember this…" opens under the header.
        anchor={
          canWrite && remembering
            ? (header) => (
                <RememberPopover {...rememberProps} anchor>
                  {header}
                </RememberPopover>
              )
            : undefined
        }
        className={cn('@max-md/memory:w-full', explicit && '@max-md/memory:hidden')}
      />
      {selected ? (
        <SplitSheet
          size="lg"
          open={history?.mode === 'sheet' && !!page.data}
          onOpenChange={(open) => !open && setHistory(null)}
          className={cn('min-w-0 flex-1', !explicit && '@max-md/memory:hidden')}
        >
          <SplitSheetMain className="flex flex-col">
            <MemoryReader
              projectId={projectId}
              summary={selected}
              page={page.data?.page_id === selected.page_id ? page.data : undefined}
              pageError={page.isError}
              pages={pages}
              editing={editing && !!page.data}
              editorRun={editorRun}
              onRetry={() => void page.refetch()}
              onSelectPage={setPage}
              onBack={() => setPage(null)}
              onEdit={() => setEditing(true)}
              onHistory={() => setHistory((open) => ({ versionId: open?.versionId ?? null, mode: 'sheet' }))}
              onEditDone={() => setEditing(false)}
              onReload={() => void page.refetch().then(() => setEditorRun((run) => run + 1))}
              onRemoved={() => {
                setGone({ pageId: selected.page_id, list: list.data });
                setPage(null);
              }}
              previewId={history && history.mode !== 'closed' ? history.versionId : null}
              previewFocus={history?.mode === 'preview'}
              onPreviewEnd={() =>
                setHistory((open) =>
                  open?.mode === 'preview' ? { ...open, mode: 'closed' } : open && { versionId: null, mode: 'sheet' },
                )
              }
            />
          </SplitSheetMain>
          {history?.mode === 'sheet' && page.data ? (
            <MemoryHistory
              projectId={projectId}
              page={page.data}
              previewId={history.versionId}
              onPreview={(versionId, covered) =>
                setHistory({ versionId, mode: covered && versionId ? 'preview' : 'sheet' })
              }
              onRestored={() => setHistory({ versionId: null, mode: 'sheet' })}
            />
          ) : null}
        </SplitSheet>
      ) : (
        <MemoryAll kind={kind} place={place} pages={pages} onSelect={setPage} className="@max-md/memory:hidden" />
      )}
    </div>
  );
}
