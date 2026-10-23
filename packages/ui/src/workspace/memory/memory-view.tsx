'use client';

import { useProjectMemoryLayer, useProjectMemoryPage, useProjectMemoryPages } from '@kortix/sdk/react';
import { useMemo, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { SplitSheet, SplitSheetMain } from '../../primitives/split-sheet';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { MemoryEditor } from './memory-editor';
import { MemoryEmpty } from './memory-empty';
import { MemoryHistory } from './memory-history';
import { MEMORY_GROUPS, memoryPageCount } from './memory-labels';
import { groupMemoryPages, MemoryPageList } from './memory-page-list';
import { MemoryReader } from './memory-reader';
import { RememberBar } from './remember-bar';

/** The open page, in the URL so a page can be linked (the thread's "Saved to memory · View" uses it). */
export const MEMORY_PAGE_PARAM = 'page';
/** Set with `page`: the page opens with its History beside it. */
export const MEMORY_HISTORY_PARAM = 'history';

export interface MemoryViewProps {
  projectId: string;
  /** `company`, or the space id of a channel or DM. */
  layerKey: string;
  /** "#marketing", the DM's agent, or "Company": the copy's name for the layer. */
  place: string;
}

/**
 * A layer's memory: the page list on the left, the open page on the right
 * (its History in a sheet beside it), and the Remember bar along the bottom.
 * A layer with no pages shows what memory is and three sentences to try.
 * The same view serves a channel, a DM and the Company page.
 */
export function MemoryView({ projectId, layerKey, place }: MemoryViewProps) {
  const t = useTranslations('spaces.memory');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const layer = useProjectMemoryLayer(projectId, layerKey);
  const list = useProjectMemoryPages(projectId, layerKey);
  const [draft, setDraft] = useState('');
  const rememberInput = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  // Bumped by the editor's Reload: a fresh form on the newest version. Not the
  // version itself: a save bumps it too, and a remount would drop the save's
  // own onSuccess (TanStack skips call-time callbacks of an unmounted caller).
  const [editorRun, setEditorRun] = useState(0);
  // Open History: `versionId` null shows the newest version.
  // `?history=1` (the thread line's "open History") opens it on arrival.
  const [history, setHistory] = useState<{ versionId: string | null } | null>(() =>
    searchParams.get(MEMORY_HISTORY_PARAM) ? { versionId: null } : null,
  );

  // A page this view just deleted (or whose creation it undid) leaves the list
  // at once, until the list refetches (an Undo may bring it back after that).
  const [gone, setGone] = useState<{ pageId: string; list: unknown } | null>(null);
  const pages = useMemo(() => {
    const all = list.data ?? [];
    return gone && gone.list === list.data ? all.filter((page) => page.page_id !== gone.pageId) : all;
  }, [list.data, gone]);
  const requested = searchParams.get(MEMORY_PAGE_PARAM);
  const explicit = pages.find((page) => page.page_id === requested);
  // No page in the URL (or one that is gone): the first page of the list.
  const selected = useMemo(() => {
    if (explicit) return explicit;
    const { groups } = groupMemoryPages(pages);
    for (const type of MEMORY_GROUPS) {
      const first = groups.get(type)?.[0];
      if (first) return first;
    }
    return pages[0];
  }, [explicit, pages]);
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
    // The list's shape is known: its rows load as skeletons, the page waits.
    return (
      <div aria-busy className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col gap-2.5 border-r px-3 py-4">
          <Skeleton className="h-8 w-full rounded-md" />
          {['w-3/5', 'w-2/5', 'w-3/4', 'w-1/2', 'w-2/5', 'w-2/3'].map((width, index) => (
            <Skeleton key={index} className={cn('h-4 rounded-sm', width)} />
          ))}
        </div>
      </div>
    );
  }

  const canWrite = layer.data.can_write && !layer.data.read_only;
  const kind = layer.data.scope;
  const rememberBar = canWrite ? (
    <RememberBar
      projectId={projectId}
      layerKey={layerKey}
      place={place}
      draft={draft}
      onDraftChange={setDraft}
      inputRef={rememberInput}
    />
  ) : null;

  // The Remember bar stays the root's last child in both layouts, so it keeps
  // its draft and its "Saved" line when the first note turns the empty state
  // into the list.
  return (
    <div className="@container/memory flex min-h-0 flex-1 flex-col">
      {!selected ? (
        <MemoryEmpty
          kind={kind}
          place={place}
          onTry={
            canWrite
              ? (text) => {
                  setDraft(text);
                  rememberInput.current?.focus();
                }
              : undefined
          }
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Too narrow for both: the list, until a page is opened; then the page, with a way back. */}
          <MemoryPageList
            projectId={projectId}
            layerKey={layerKey}
            pages={pages}
            total={memoryPageCount(layer.data.counts)}
            selectedId={selected.page_id}
            onSelect={setPage}
            onViewChange={(pageId, versionId) => {
              setPage(pageId);
              setHistory({ versionId });
            }}
            className={cn('@max-2xl/memory:w-full', explicit && '@max-2xl/memory:hidden')}
          />
          <SplitSheet
            size="lg"
            open={history !== null && !!page.data}
            onOpenChange={(open) => !open && setHistory(null)}
            className={cn('min-w-0 flex-1', !explicit && '@max-2xl/memory:hidden')}
          >
            <SplitSheetMain className="flex flex-col">
              {editing && page.data ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 @2xl/memory:px-11">
                  <MemoryEditor
                    key={`${page.data.page_id}:${editorRun}`}
                    projectId={projectId}
                    page={page.data}
                    onDone={() => setEditing(false)}
                    onReload={() => void page.refetch().then(() => setEditorRun((run) => run + 1))}
                  />
                </div>
              ) : (
                <MemoryReader
                  projectId={projectId}
                  summary={selected}
                  page={page.data?.page_id === selected.page_id ? page.data : undefined}
                  pageError={page.isError}
                  onRetry={() => void page.refetch()}
                  pages={pages}
                  onSelectPage={setPage}
                  onBack={() => setPage(null)}
                  onEdit={() => setEditing(true)}
                  onHistory={(versionId) => setHistory({ versionId: versionId ?? null })}
                  onRemoved={() => {
                    setGone({ pageId: selected.page_id, list: list.data });
                    setPage(null);
                  }}
                />
              )}
            </SplitSheetMain>
            {history && page.data ? (
              <MemoryHistory
                projectId={projectId}
                page={page.data}
                selectedId={history.versionId}
                onSelect={(versionId) => setHistory({ versionId })}
                onRestored={() => setHistory({ versionId: null })}
              />
            ) : null}
          </SplitSheet>
        </div>
      )}
      {rememberBar}
    </div>
  );
}

/** The Memory tab's count: the layer's live pages, notes not included. */
export function useMemoryPageCount(projectId: string, layerKey: string | null | undefined): number {
  return memoryPageCount(useProjectMemoryLayer(projectId, layerKey).data?.counts);
}
