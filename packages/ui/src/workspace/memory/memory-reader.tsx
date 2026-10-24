'use client';

import type { ProjectMemoryPage, ProjectMemoryPageSummary } from '@kortix/sdk';
import { useDeleteProjectMemoryPage } from '@kortix/sdk/react';
import { CaretLeftIcon, ClockCounterClockwiseIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast } from '../../primitives/toast';
import { cn } from '../../lib/utils';
import { useMemoryAuthorName } from './memory-labels';
import { MemoryBody } from './memory-body';
import { SourceList } from './source-mark';

/** A named person or agent wrote the page; a file with no front-matter has the `system` author and shows no "by …". */
function hasAuthor(author: ProjectMemoryPageSummary['updated_by']): boolean {
  return author.kind === 'agent' ? !!author.agent : author.kind === 'person' && !!author.name;
}

/** The reader's three quiet bordered buttons: Edit, History, Delete. */
const ACTION = 'text-muted-foreground hover:text-foreground font-normal';

/**
 * One page, across the reader's width: the title and "Updated 2h ago by
 * Writer" top left, Edit · History · Delete top right, then the body with its
 * source numbers, the numbered sources and the related pages. `editor`
 * replaces the body while it is edited (the buttons hide; Cancel and Save sit
 * under it). Delete asks once and deletes for good. The header draws from
 * the list's summary at once; the body arrives with the page.
 */
export function MemoryReader({
  projectId,
  summary,
  page,
  pageError,
  pages,
  editing,
  editorRun,
  onRetry,
  onSelectPage,
  onBack,
  onEdit,
  onHistory,
  onEditDone,
  onReload,
  onRemoved,
}: {
  projectId: string;
  summary: ProjectMemoryPageSummary;
  page: ProjectMemoryPage | undefined;
  pageError: boolean;
  /** The layer's pages: where a relative link in the body goes. */
  pages: readonly ProjectMemoryPageSummary[];
  /** The body is being edited in place. */
  editing: boolean;
  /** Bumped by the editor's Reload: a fresh body on the newest version. */
  editorRun: number;
  onRetry: () => void;
  onSelectPage: (pageId: string) => void;
  /** Back to the list, on a container too narrow to show both. */
  onBack: () => void;
  onEdit: () => void;
  onHistory: () => void;
  /** Editing ended: saved or cancelled. */
  onEditDone: () => void;
  /** Reload after `version_conflict`. */
  onReload: () => void;
  /** The page is gone: leave it. */
  onRemoved: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  const authorName = useMemoryAuthorName();
  const remove = useDeleteProjectMemoryPage(projectId);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = () =>
    remove.mutate(summary.page_id, {
      onSuccess: () => {
        setDeleting(false);
        onRemoved();
        successToast(t('deleted'));
      },
      onError: () => errorToast(t('deleteFailed')),
    });

  return (
    <div className="@container/reader min-h-0 flex-1 overflow-y-auto">
      <article className="flex flex-col px-6 py-8 @2xl/reader:px-16 @2xl/reader:py-10">
        <Button
          variant="ghost"
          size="toolbar"
          className="text-muted-foreground mb-4 -ml-2 self-start @md/memory:hidden"
          onClick={onBack}
        >
          <CaretLeftIcon aria-hidden />
          {t('allPages')}
        </Button>
        <header className="flex flex-col items-start gap-3 @xl/reader:flex-row @xl/reader:justify-between @xl/reader:gap-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="text-2xl leading-tight font-semibold tracking-tight text-balance [overflow-wrap:anywhere]">
              {summary.title}
            </h2>
            <p className="text-muted-foreground text-xs leading-snug">
              {hasAuthor(summary.updated_by)
                ? t('updated', { time: relativeTime(summary.updated_at, locale), author: authorName(summary.updated_by) })
                : t('updatedAt', { time: relativeTime(summary.updated_at, locale) })}
            </p>
          </div>
          {/* While editing the buttons hide but keep their place, so the body does not move. */}
          {!page ? null : (
            <div
              className={cn('flex shrink-0 flex-wrap items-center gap-1.5 pt-0.5', editing && 'invisible')}
              aria-hidden={editing || undefined}
              inert={editing || undefined}
            >
              {page.can_edit ? (
                <Button variant="outline" size="toolbar" className={ACTION} onClick={onEdit}>
                  <PencilSimpleIcon aria-hidden />
                  {t('edit')}
                </Button>
              ) : null}
              <Button variant="outline" size="toolbar" className={ACTION} onClick={onHistory}>
                <ClockCounterClockwiseIcon aria-hidden />
                {t('history.title')}
              </Button>
              {page.can_delete ? (
                <Button variant="outline" size="toolbar" className={ACTION} onClick={() => setDeleting(true)}>
                  <TrashIcon aria-hidden />
                  {t('delete')}
                </Button>
              ) : null}
            </div>
          )}
        </header>
        {pageError && !page ? (
          <div className="pt-8">
            <ErrorState
              size="sm"
              title={t('pageLoadError')}
              action={
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t('retry')}
                </Button>
              }
            />
          </div>
        ) : page ? (
          <>
            <MemoryBody
              key={`${page.page_id}:${page.version_no}:${editorRun}`}
              projectId={projectId}
              page={page}
              pages={pages}
              editing={editing}
              onSelectPage={onSelectPage}
              onDone={onEditDone}
              onReload={onReload}
            />
            <PageFooter projectId={projectId} page={page} onSelectPage={onSelectPage} />
          </>
        ) : (
          <DelayedBodySkeleton />
        )}
      </article>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteTitle', { title: summary.title })}
        description={t('deleteDescription')}
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/** A text line's placeholder inside the line box of `line` (its font size and line height), so the real line lands where it sat. */
function Line({ line, className }: { line: string; className: string }) {
  return (
    <div className={line}>
      <Skeleton className={cn('inline-block rounded-sm py-0 align-middle', className)} />
    </div>
  );
}

/** The body's placeholder: three paragraphs at the body's type, line height and gap. */
function BodySkeleton() {
  const BODY = 'text-base leading-relaxed';
  return (
    <div aria-busy className="flex flex-col gap-4 pt-8">
      <div>
        <Line line={BODY} className="h-3.5 w-full" />
        <Line line={BODY} className="h-3.5 w-1/2" />
      </div>
      <div>
        <Line line={BODY} className="h-3.5 w-full" />
        <Line line={BODY} className="h-3.5 w-2/3" />
      </div>
      <Line line={BODY} className="h-3.5 w-5/6" />
    </div>
  );
}

/** The body's placeholder after 150 ms: a page that loads faster shows none (no flash). */
function DelayedBodySkeleton() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return shown ? <BodySkeleton /> : null;
}

/**
 * The reader before the layer has loaded: the title's and "Updated …"'s line
 * boxes, then the body. No Edit, History or Delete: they come with the page.
 */
export function MemoryReaderSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('@container/reader min-h-0 flex-1 overflow-hidden', className)}>
      <div className="flex flex-col px-6 py-8 @2xl/reader:px-16 @2xl/reader:py-10">
        {/* Where "All pages" sits on a narrow container. */}
        <div className="mb-4 h-7 @md/memory:hidden" />
        <div className="flex flex-col gap-1.5">
          <Line line="text-2xl leading-tight" className="h-5 w-56" />
          <Line line="text-xs leading-snug" className="h-2.5 w-36" />
        </div>
        <BodySkeleton />
      </div>
    </div>
  );
}

/** Under the body: the numbered sources and the related pages. */
function PageFooter({
  projectId,
  page,
  onSelectPage,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  onSelectPage: (pageId: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  return (
    <>
      {page.sources.length > 0 ? <SourceList sources={page.sources} projectId={projectId} /> : null}
      {page.related.length > 0 ? (
        <div className="flex flex-col gap-2.5 pt-8">
          <h3 className="text-muted-foreground text-xs leading-snug">{t('relatedPages')}</h3>
          <div className="flex flex-wrap gap-2">
            {page.related.map((related) => (
              <Button
                key={related.page_id}
                variant="outline"
                size="sm"
                className="max-w-full px-3.5 text-xs font-normal"
                onClick={() => onSelectPage(related.page_id)}
              >
                <span className="truncate">{related.title}</span>
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
