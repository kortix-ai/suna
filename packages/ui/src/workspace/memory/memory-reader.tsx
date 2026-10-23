'use client';

import type { ProjectMemoryPage, ProjectMemoryPageSummary, ProjectMemorySource } from '@kortix/sdk';
import { useDeleteProjectMemoryPage } from '@kortix/sdk/react';
import { CaretLeftIcon, DotsThreeIcon, TrashIcon } from '@phosphor-icons/react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { Copy } from '../../icons/copy';
import { relativeTime } from '../../internal/lib/relative-time';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import { ErrorState } from '../../primitives/error-state';
import { Skeleton } from '../../primitives/skeleton';
import { errorToast, successToast, undoToast } from '../../primitives/toast';
import { type MemoryBlock, type MemoryInline, memoryBlocks } from './body-tokens';
import { MEMORY_TYPE_ICON, MemoryAuthorAvatar, useMemoryAuthorName } from './memory-labels';
import { MemoryRecentChange, useUndoMemoryChange } from './memory-recent-change';
import { SourceChip } from './source-chip';

/**
 * One page: the agent's recent change (if any), the type, title and who
 * updated it from which thread, Edit · History · ⋯, then the summary, the
 * body with its source chips, and the related pages. The header draws from
 * the list's summary at once; the body arrives with the page.
 */
export function MemoryReader({
  projectId,
  summary,
  page,
  pageError,
  onRetry,
  pages,
  onSelectPage,
  onBack,
  onEdit,
  onHistory,
  onRemoved,
}: {
  projectId: string;
  summary: ProjectMemoryPageSummary;
  page: ProjectMemoryPage | undefined;
  pageError: boolean;
  onRetry: () => void;
  /** The layer's pages, for the related chips' type glyphs. */
  pages: readonly ProjectMemoryPageSummary[];
  onSelectPage: (pageId: string) => void;
  /** Back to the list, on a container too narrow to show both. */
  onBack: () => void;
  onEdit: () => void;
  /** Open History, at one version or at the newest. */
  onHistory: (versionId?: string) => void;
  /** The page is gone (deleted, or its creation undone): leave it. */
  onRemoved: () => void;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  const authorName = useMemoryAuthorName();
  const remove = useDeleteProjectMemoryPage(projectId);
  const undo = useUndoMemoryChange(projectId);
  const [deleting, setDeleting] = useState(false);
  const author = authorName(summary.updated_by);
  const meta = [
    t('updatedBy', { author }),
    summary.updated_source ? t('fromThread', { thread: summary.updated_source.label }) : null,
    relativeTime(summary.updated_at, locale),
  ].filter(Boolean);

  const copyLink = async () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('thread');
    url.searchParams.set('tab', 'memory');
    url.searchParams.set('page', summary.page_id);
    try {
      await navigator.clipboard.writeText(url.toString());
      successToast(t('linkCopied'));
    } catch {
      errorToast(t('copyFailed'));
    }
  };

  const confirmDelete = () =>
    remove.mutate(summary.page_id, {
      onSuccess: ({ version_id }) => {
        setDeleting(false);
        onRemoved();
        undoToast(t('deleted'), { undoLabel: t('undo'), onUndo: () => undo.run(version_id) });
      },
      onError: () => errorToast(t('deleteFailed')),
    });

  return (
    <div className="@container/reader min-h-0 flex-1 overflow-y-auto">
      <article className="flex flex-col gap-5 px-6 py-7 @2xl/reader:px-11">
        <Button variant="ghost" size="toolbar" className="text-muted-foreground -ml-2 self-start @2xl/memory:hidden" onClick={onBack}>
          <CaretLeftIcon aria-hidden />
          {t('allPages')}
        </Button>
        <MemoryRecentChange projectId={projectId} page={summary} onViewChange={onHistory} onRemoved={onRemoved} />
        <header className="flex max-w-3xl flex-col items-start gap-4 @xl/reader:flex-row @xl/reader:justify-between @xl/reader:gap-6">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="text-muted-foreground text-xs">{t(`type.${summary.type}`)}</p>
            <h2 className="text-2xl font-semibold tracking-tight text-balance [overflow-wrap:anywhere]">{summary.title}</h2>
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <MemoryAuthorAvatar author={summary.updated_by} name={author} />
              <span className="truncate">{meta.join(' · ')}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {page?.can_edit ? (
              <Button variant="outline" size="toolbar" onClick={onEdit}>
                {t('edit')}
              </Button>
            ) : null}
            <Button variant="outline" size="toolbar" onClick={() => onHistory()}>
              {t('history.title')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label={t('more')}>
                  <DotsThreeIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={copyLink}>
                  <Copy className="size-3.5 shrink-0" />
                  {t('copyLink')}
                </DropdownMenuItem>
                {page?.can_delete ? (
                  <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                    <TrashIcon className="size-3.5 shrink-0" />
                    {t('delete')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        {pageError && !page ? (
          <ErrorState
            size="sm"
            title={t('pageLoadError')}
            action={
              <Button variant="outline" size="sm" onClick={onRetry}>
                {t('retry')}
              </Button>
            }
          />
        ) : page ? (
          <PageBody projectId={projectId} page={page} pages={pages} onSelectPage={onSelectPage} />
        ) : (
          <div aria-busy className="flex max-w-2xl flex-col gap-3 pt-1">
            <Skeleton className="h-4 w-11/12 rounded-sm" />
            <Skeleton className="h-4 w-3/4 rounded-sm" />
            <Skeleton className="h-4 w-1/2 rounded-sm" />
          </div>
        )}
      </article>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={t('deleteTitle')}
        description={t('deleteDescription', { title: summary.title })}
        confirmLabel={t('delete')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function PageBody({
  projectId,
  page,
  pages,
  onSelectPage,
}: {
  projectId: string;
  page: ProjectMemoryPage;
  pages: readonly ProjectMemoryPageSummary[];
  onSelectPage: (pageId: string) => void;
}) {
  const t = useTranslations('spaces.memory');
  const sources = useMemo(() => new Map(page.sources.map((source) => [source.number, source])), [page.sources]);
  // Each `## ` heading opens a section: its facts sit close under it, sections apart.
  const sections = useMemo(() => {
    const out: MemoryBlock[][] = [];
    for (const block of memoryBlocks(page.body, new Set(sources.keys()))) {
      if (block.kind === 'heading' || out.length === 0) out.push([]);
      out[out.length - 1]!.push(block);
    }
    return out;
  }, [page.body, sources]);
  const typeOf = useMemo(() => new Map(pages.map((p) => [p.page_id, p.type])), [pages]);
  const inline = (parts: MemoryInline[]) => <Inlines parts={parts} sources={sources} projectId={projectId} />;

  return (
    <div className="flex max-w-2xl flex-col gap-5 pt-1">
      {page.summary ? <p className="text-muted-foreground text-base leading-relaxed">{page.summary}</p> : null}
      {!page.summary && !page.body.trim() && page.related.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('emptyPage')}</p>
      ) : null}
      {sections.map((blocks, index) => (
        <section key={index} className="flex flex-col gap-2">
          {blocks.map((block, i) => (
            <Block key={i} block={block} inline={inline} />
          ))}
        </section>
      ))}
      {page.related.length > 0 ? (
        <div className="flex flex-col gap-2.5 pt-1.5">
          <h3 className="text-muted-foreground text-xs">{t('relatedPages')}</h3>
          <div className="flex flex-wrap gap-2">
            {page.related.map((related) => {
              const type = typeOf.get(related.page_id);
              const Glyph = type ? MEMORY_TYPE_ICON[type] : null;
              return (
                <Button
                  key={related.page_id}
                  variant="secondary"
                  size="toolbar"
                  className="max-w-full"
                  onClick={() => onSelectPage(related.page_id)}
                >
                  {Glyph ? <Glyph aria-hidden className="text-muted-foreground" /> : null}
                  <span className="truncate">{related.title}</span>
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Block({ block, inline }: { block: MemoryBlock; inline: (parts: MemoryInline[]) => ReactNode }) {
  switch (block.kind) {
    case 'heading':
      return <h3 className="text-sm font-semibold">{inline(block.inlines)}</h3>;
    case 'paragraph':
      return <p className="text-base leading-relaxed">{inline(block.inlines)}</p>;
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List
          className={
            block.ordered
              ? 'marker:text-muted-foreground flex list-decimal flex-col gap-2 pl-5'
              : 'marker:text-muted-foreground flex list-disc flex-col gap-2 pl-5'
          }
        >
          {block.items.map((item, i) => (
            <li key={i} className="text-base leading-relaxed">
              {inline(item)}
            </li>
          ))}
        </List>
      );
    }
    case 'code':
      return <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">{block.text}</pre>;
  }
}

function Inlines({
  parts,
  sources,
  projectId,
}: {
  parts: MemoryInline[];
  sources: Map<number, ProjectMemorySource>;
  projectId: string;
}) {
  return parts.map((part, i) => {
    switch (part.kind) {
      case 'text':
        return <Fragment key={i}>{part.text}</Fragment>;
      case 'strong':
        return (
          <strong key={i} className="font-semibold">
            {part.text}
          </strong>
        );
      case 'code':
        return (
          <code key={i} className="bg-muted rounded-sm px-1 font-mono">
            {part.text}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {part.text}
          </a>
        );
      case 'source': {
        const source = sources.get(part.number);
        return source ? <SourceChip key={i} source={source} projectId={projectId} /> : null;
      }
    }
  });
}
