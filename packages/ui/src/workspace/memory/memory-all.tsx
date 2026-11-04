'use client';

import type { ProjectMemoryPageSummary } from '@kortix/sdk';
import { SunDimIcon } from '@phosphor-icons/react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../lib/utils';
import { Skeleton } from '../../primitives/skeleton';
import { groupMemoryPages } from './memory-page-list';
import { Line } from './memory-reader';

/** The reader's frame: the All view and its skeleton sit where a page's title does. */
const FRAME = 'flex flex-col px-6 py-8 @2xl/reader:px-16 @2xl/reader:py-10';
const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-3';

/**
 * The layer at a glance, the landing view of a channel's, a DM's and the
 * Company memory: "All" and "16 pages", one line on what memory is, then a
 * card per page in the list's groups (About first). A card shows the title,
 * "Updated 2h ago" and the page's opening, fading out; it opens the page.
 */
export function MemoryAll({
  kind,
  place,
  pages,
  onSelect,
  className,
}: {
  kind: 'company' | 'channel' | 'dm';
  /** "#marketing" or the DM's agent. */
  place: string;
  /** Sorted by `sortMemoryPages`. */
  pages: readonly ProjectMemoryPageSummary[];
  onSelect: (pageId: string) => void;
  className?: string;
}) {
  const t = useTranslations('spaces.memory');
  const locale = useLocale();
  return (
    <div className={cn('@container/reader min-h-0 flex-1 overflow-y-auto', className)}>
      <div className={FRAME}>
        <header className="flex flex-col gap-1.5">
          <h2 className="text-2xl leading-tight font-semibold tracking-tight">{t('all.title')}</h2>
          <p className="text-muted-foreground text-xs leading-snug tabular-nums">{t('pageCount', { count: pages.length })}</p>
        </header>
        <p className="text-muted-foreground mt-6 flex items-center gap-2.5 rounded-md border px-3 py-2 text-xs">
          <span className="bg-muted text-foreground flex size-6 shrink-0 items-center justify-center rounded-sm">
            <SunDimIcon aria-hidden className="size-3.5" />
          </span>
          <span className="min-w-0 text-pretty">
            {t(kind === 'company' ? 'all.explainCompany' : kind === 'dm' ? 'all.explainDm' : 'all.explainChannel', { place })}
          </span>
        </p>
        {groupMemoryPages(pages).map((group) => (
          <section key={group.type} aria-label={t(`group.${group.type}`)} className="mt-8 flex flex-col gap-2">
            <h3 className="text-muted-foreground text-xs">{t(`group.${group.type}`)}</h3>
            <ul className={GRID}>
              {group.pages.map((page) => (
                <li key={page.page_id} className="flex">
                  <button
                    type="button"
                    onClick={() => onSelect(page.page_id)}
                    className="hover:bg-secondary focus-visible:ring-ring duration-fast flex w-full flex-col gap-1 rounded-md border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2"
                  >
                    <span className="text-foreground line-clamp-2 text-sm font-medium text-pretty [overflow-wrap:anywhere]">
                      {page.title}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t('updatedAt', { time: relativeTime(page.updated_at, locale) })}
                    </span>
                    {page.excerpt ? (
                      <span className="text-muted-foreground mt-1 line-clamp-4 mask-b-from-50% text-xs leading-relaxed [overflow-wrap:anywhere]">
                        {page.excerpt}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The All view's line boxes while the layer loads. */
export function MemoryAllSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('@container/reader min-h-0 flex-1 overflow-hidden', className)}>
      <div className={FRAME}>
        <div className="flex flex-col gap-1.5">
          <Line line="text-2xl leading-tight" className="h-5 w-16" />
          <Line line="text-xs leading-snug" className="h-2.5 w-14" />
        </div>
        <Skeleton className="mt-6 h-11 w-full rounded-md py-0" />
        <div className="mt-8 flex flex-col gap-2">
          <Skeleton className="h-2.5 w-12 rounded-sm py-0" />
          <div className={GRID}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-32 rounded-md py-0" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
