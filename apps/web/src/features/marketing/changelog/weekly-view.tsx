import { getLocale, getTranslations } from '@/i18n/get-translations';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@kortix/ui/separator';
import { ArrowRightIcon } from '@/features/icon/arrow-right';
import { cn } from '@kortix/ui';
import Link from 'next/link';

import { ChangelogAnchorRedirect } from './anchor-redirect';
import { ReleaseNotes } from './changelog-view';
import { CopyLinkButton } from './copy-link-button';
import { changelogPageHref } from './paging';
import type { ChangelogWeek, ChangelogWeekly } from './types';

/** "October 12 – 18, 2026". Weeks are UTC, so the dates are too. */
export function weekRange(week: ChangelogWeek, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  // `end` is exclusive: the last day is the Sunday before it.
  return format.formatRange(new Date(week.start), new Date(Date.parse(week.end) - 1));
}

/** The week's agent-written summary: 1–5 plain lines, one bullet each. */
export function WeekSummary({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <ul
      className={cn(
        'text-foreground marker:text-muted-foreground list-disc space-y-3 pl-5 text-[15px] leading-7',
        className,
      )}
    >
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

export async function WeeklyView({ data }: { data: ChangelogWeekly }) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const locale = await getLocale();
  const releaseDate = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const list = new Intl.ListFormat(locale, { type: 'conjunction' });
  const { weeks, tagPages } = data;

  return (
    <main className="bg-background min-h-screen">
      {/* `page={0}` is never a real page: an old `/changelog#v0.14.2` link
          moves to the Release history page that renders that release. */}
      <ChangelogAnchorRedirect page={0} tagPages={tagPages} />
      <div className="mx-auto max-w-7xl px-6 pb-24 sm:pb-32">
        <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 pt-28 pb-16 sm:pt-36 sm:pb-28">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            {tI18nComplete.raw('text68b8fd794db4')}
          </h1>
          <Button asChild variant="ghost" className="group/arrow-right -mr-3">
            <Link href={changelogPageHref(1)}>
              {tI18nComplete.raw('textf952fee736ed')}
              <ArrowRightIcon />
            </Link>
          </Button>
        </header>

        {weeks.length === 0 ? (
          <div>
            <Separator />
            <p className="text-muted-foreground pt-10 text-sm">
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextCouldnTLoad69c0f1db')}{' '}
              <Link
                href={changelogPageHref(1)}
                className="text-foreground hover:text-muted-foreground focus-visible:text-muted-foreground transition-colors outline-none"
              >
                {tI18nComplete.raw('textf952fee736ed')}
              </Link>
            </p>
          </div>
        ) : (
          // Each week: hairline, a date row, then the reference changelog's
          // 2-col split. Left is the sticky identity (headline + the releases
          // that shipped it), right is the week's headline features and a count
          // of everything else, which Release history lists in full.
          weeks.map((week) => {
            const weekHref = `/changelog/${week.slug}`;
            // Everything the highlights leave out, as one line of counts. The
            // summary rephrases rather than lists New items, so it leaves all of them.
            const shownNew = week.summary ? 0 : week.highlights.length;
            const rest = [
              week.counts.new - shownNew > 0 &&
                tI18nComplete('textb8471beb7d98', {
                  count: week.counts.new - shownNew,
                }),
              week.counts.improved > 0 &&
                tI18nComplete('text48198dbb8f5e', { count: week.counts.improved }),
              week.counts.fixed > 0 &&
                tI18nComplete('text1d511e2b26ca', { count: week.counts.fixed }),
            ].filter((part): part is string => Boolean(part));
            return (
              <article key={week.id} id={week.slug} className="scroll-mt-24">
                <Separator />
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-12 sm:pt-16">
                  <div className="flex flex-wrap items-center gap-3">
                    <time
                      dateTime={week.start}
                      className="text-muted-foreground text-sm tabular-nums"
                    >
                      {weekRange(week, locale)}
                    </time>
                    {week.inProgress && (
                      <Badge size="sm" variant="kortix" className="rounded">
                        {tI18nComplete.raw('text8c4eef5ab253')}
                      </Badge>
                    )}
                  </div>
                  <CopyLinkButton href={weekHref} className="-mr-3" />
                </div>

                <div className="grid gap-x-16 gap-y-10 pt-8 pb-12 sm:pt-10 sm:pb-16 lg:grid-cols-2">
                  <div className="self-start lg:sticky lg:top-24">
                    <h2 className="text-foreground text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                      <Link
                        href={weekHref}
                        className="focus-visible:text-muted-foreground transition-colors outline-none"
                      >
                        {week.headline}
                      </Link>
                    </h2>
                    <ul className="mt-8 space-y-1">
                      {week.releases.map((release) => (
                        <li key={release.tag}>
                          <Link
                            href={release.href}
                            title={release.headline}
                            className="hover:bg-hover focus-visible:bg-hover duration-fast -mx-2 flex w-fit items-baseline gap-3 rounded-md px-2 py-1 text-sm transition-colors outline-none"
                          >
                            <span className="text-foreground font-mono tabular-nums">
                              {release.tag}
                            </span>
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
                  </div>

                  <div className="min-w-0">
                    {week.summary ? (
                      <WeekSummary lines={week.summary} />
                    ) : week.highlights.length > 0 ? (
                      <ul className="space-y-6">
                        {week.highlights.map((highlight, i) => (
                          <li key={i}>
                            {highlight.title && (
                              <h3 className="text-foreground text-[15px] leading-7 font-medium">
                                {highlight.title}
                              </h3>
                            )}
                            {highlight.html && <ReleaseNotes html={highlight.html} />}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      // Hotfix-only weeks have notes without sections: list
                      // what each release was about instead.
                      <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-[15px] leading-7">
                        {week.releases.map((release) => (
                          <li key={release.tag}>{release.headline}</li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-10 space-y-2 text-sm">
                      {rest.length > 0 && (
                        <p className="text-muted-foreground">{list.format(rest)}</p>
                      )}
                      <Link
                        href={weekHref}
                        className="text-foreground hover:text-muted-foreground focus-visible:text-muted-foreground inline-block transition-colors outline-none"
                      >
                        {tI18nComplete.raw('text1baa58fb1774')}
                      </Link>
                    </div>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </main>
  );
}
