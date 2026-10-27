import { getLocale, getTranslations } from '@/i18n/get-translations';

import { Band, PageFrame } from '@/features/marketing/kit/page-frame';
import { ArrowLeftIcon } from '@/lib/icons/ssr';
import { Badge } from '@kortix/ui/badge';
import { CountBadge } from '@kortix/ui/count-badge';
import Link from 'next/link';

import { ReleaseNotes } from './changelog-view';
import { CopyLinkButton } from './copy-link-button';
import type { ChangelogWeekDetail } from './types';
import { WeekSummary, weekRange } from './weekly-view';

/**
 * `/changelog/<slug>`: one week with every New, Improved and Fixed item,
 * merged across its releases. Same frame as `/changelog` and Release
 * history: the landing page's rails, then one band whose rows are split by
 * hairlines, a sticky label on the left and the list on the right.
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
    <PageFrame>
      {/* The week's identity in the hero's type: back link and copy on one
          row, then date, headline, summary and the releases that shipped it. */}
      <header className="px-8 pt-28 pb-16 lg:px-28 lg:pt-36 lg:pb-20">
        <div className="flex items-center justify-between gap-4">
          <Link
            href="/changelog"
            className="text-muted-foreground hover:text-foreground focus-visible:text-foreground -ml-1 flex items-center gap-1.5 px-1 py-1 text-sm transition-colors outline-none"
          >
            <ArrowLeftIcon className="size-4" />
            {tI18nComplete.raw('textead07c84baac')}
          </Link>
          <CopyLinkButton href={`/changelog/${week.slug}`} className="-mr-3" />
        </div>
        <div className="mt-12 flex flex-wrap items-center gap-3">
          <time dateTime={week.start} className="text-muted-foreground text-sm tabular-nums">
            {weekRange(week, locale)}
          </time>
          {week.inProgress && (
            <Badge size="sm" variant="kortix" className="rounded">
              {tI18nComplete.raw('text8c4eef5ab253')}
            </Badge>
          )}
        </div>
        <h1 className="text-foreground mt-4 max-w-261 text-3xl font-medium tracking-tight text-balance sm:text-4xl lg:text-[44px] lg:leading-13">
          {week.headline}
        </h1>
        {week.summary && <WeekSummary lines={week.summary} className="mt-8 max-w-2xl" />}
        <ul className="mt-6 -ml-2 flex flex-wrap gap-1">
          {week.releases.map((release) => (
            <li key={release.tag}>
              <Link
                href={release.href}
                title={release.headline}
                className="hover:bg-hover focus-visible:bg-hover duration-fast flex items-baseline gap-2 rounded-md px-2 py-1 text-sm transition-colors outline-none"
              >
                <span className="text-foreground font-mono tabular-nums">{release.tag}</span>
                <time dateTime={release.publishedAt} className="text-muted-foreground tabular-nums">
                  {releaseDate.format(new Date(release.publishedAt))}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      </header>

      {/* New, Improved, Fixed: a band each, so every hairline crosses the
          page. The label sticks on the left; the notes run on the right. */}
      <section className="pb-20 lg:pb-28">
        {parts.map((part) =>
          part.html ? (
            <Band key={part.key} className="-mt-px first:mt-0">
              <div id={part.key} className="grid scroll-mt-24 grid-cols-1 lg:grid-cols-[1fr_2fr]">
                <div className="flex items-center gap-3 self-start px-6 pt-12 pb-8 lg:sticky lg:top-24 lg:px-11 lg:py-20">
                  <h2 className="text-foreground text-xl font-medium tracking-tight md:text-2xl">
                    {part.label}
                  </h2>
                  <CountBadge count={part.count} />
                </div>
                <div className="min-w-0 px-6 pb-12 lg:px-11 lg:py-20">
                  <ReleaseNotes html={part.html} />
                </div>
              </div>
            </Band>
          ) : null,
        )}
      </section>
    </PageFrame>
  );
}
