import { getLocale, getTranslations } from '@/i18n/get-translations';

import { Badge } from '@kortix/ui/badge';
import { CountBadge } from '@kortix/ui/count-badge';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@kortix/ui/separator';
import { ArrowLeftIcon } from '@/lib/icons/ssr';
import Link from 'next/link';

import { ReleaseNotes } from './changelog-view';
import { CopyLinkButton } from './copy-link-button';
import type { ChangelogWeekDetail } from './types';
import { weekRange } from './weekly-view';

/**
 * `/changelog/<slug>`: one week with every New, Improved and Fixed item,
 * merged across its releases. Same column grid as `/changelog` and Release
 * history: each section is a hairline, a sticky label on the left and the
 * list on the right.
 */
export async function WeekView({ data }: { data: ChangelogWeekDetail }) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const locale = await getLocale();
  const releaseDate = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const { week, sections } = data;
  const parts = [
    {
      key: 'new',
      label: tI18nComplete.raw('text18fdd549b2ed'),
      count: week.counts.new,
      html: sections.new,
    },
    {
      key: 'improved',
      label: tI18nComplete.raw('textc3eb9e6f2b69'),
      count: week.counts.improved,
      html: sections.improved,
    },
    {
      key: 'fixed',
      label: tI18nComplete.raw('text59e5965495d9'),
      count: week.counts.fixed,
      html: sections.fixed,
    },
  ];

  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-7xl px-6 pb-24 sm:pb-32">
        {/* Actions share one toolbar row; the week's identity (date, title,
            releases) reads as one block under it. */}
        <div className="flex items-center justify-between gap-4 pt-24 sm:pt-28">
          <Button asChild variant="ghost" size="sm" className="-ml-3">
            <Link href="/changelog">
              <ArrowLeftIcon />
              {tI18nComplete.raw('textead07c84baac')}
            </Link>
          </Button>
          <CopyLinkButton href={`/changelog/${week.slug}`} className="-mr-3" />
        </div>

        <header className="pt-14 pb-14 sm:pt-20 sm:pb-20">
          <div className="flex flex-wrap items-center gap-3">
            <time dateTime={week.start} className="text-muted-foreground text-sm tabular-nums">
              {weekRange(week, locale)}
            </time>
            {week.inProgress && (
              <Badge size="sm" variant="kortix" className="rounded">
                {tI18nComplete.raw('text8c4eef5ab253')}
              </Badge>
            )}
          </div>
          <h1 className="mt-4 max-w-4xl text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            {week.headline}
          </h1>
          <ul className="mt-6 -ml-2 flex flex-wrap gap-x-1 gap-y-1">
            {week.releases.map((release) => (
              <li key={release.tag}>
                <Link
                  href={release.href}
                  title={release.headline}
                  className="hover:bg-hover focus-visible:bg-hover duration-fast flex items-baseline gap-2 rounded-md px-2 py-1 text-sm transition-colors outline-none"
                >
                  <span className="text-foreground font-mono tabular-nums">{release.tag}</span>
                  <time
                    dateTime={release.publishedAt}
                    className="text-muted-foreground tabular-nums"
                  >
                    {releaseDate.format(new Date(release.publishedAt))}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </header>

        {parts.map((part) =>
          part.html ? (
            <section key={part.key} id={part.key} className="scroll-mt-24">
              <Separator />
              <div className="grid gap-x-16 gap-y-8 py-14 sm:py-20 lg:grid-cols-2">
                <div className="flex items-center gap-3 self-start lg:sticky lg:top-24">
                  <h2 className="text-foreground text-2xl font-medium tracking-tight">
                    {part.label}
                  </h2>
                  <CountBadge count={part.count} />
                </div>
                <div className="min-w-0">
                  <ReleaseNotes html={part.html} />
                </div>
              </div>
            </section>
          ) : null,
        )}
      </div>
    </main>
  );
}
