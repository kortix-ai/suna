import { getLocale, getTranslations } from '@/i18n/get-translations';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import Link from 'next/link';

import { ChangelogAnchorRedirect } from './anchor-redirect';
import { ReleaseNotes } from './changelog-view';
import { CopyLinkButton } from './copy-link-button';
import { changelogPageHref } from './paging';
import type { ChangelogWeek, ChangelogWeekly } from './types';

/** The hero line under "Changelog / What shipped". English until it has a key. */
const CHANGELOG_SUB = 'What shipped in Kortix each week, straight from our production releases.';

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
        'text-foreground marker:text-muted-foreground list-disc space-y-3 pl-5 text-base',
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
  const { weeks, tagPages } = data;

  return (
    <PageFrame>
      {/* `page={0}` is never a real page: an old `/changelog#v0.14.2` link
          moves to the Release history page that renders that release. */}
      <ChangelogAnchorRedirect page={0} tagPages={tagPages} />
      <PageHero
        title={tI18nComplete.raw('textead07c84baac')}
        titleMuted={tI18nComplete.raw('text68b8fd794db4')}
        sub={CHANGELOG_SUB}
        actions={
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
            <Link href={changelogPageHref(1)}>{tI18nComplete.raw('textf952fee736ed')}</Link>
          </MarketingButton>
        }
      />

      <section className="pb-20 lg:pb-28">
        {weeks.length === 0 ? (
          <Band>
            <p className="text-muted-foreground px-6 py-10 text-sm lg:px-11">
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextCouldnTLoad69c0f1db')}{' '}
              <Link
                href={changelogPageHref(1)}
                className="text-foreground hover:text-muted-foreground focus-visible:text-muted-foreground transition-colors outline-none"
              >
                {tI18nComplete.raw('textf952fee736ed')}
              </Link>
            </p>
          </Band>
        ) : (
          // One band per week, so every hairline between two weeks crosses
          // the page. Left: the sticky identity (date, headline, the
          // releases that shipped it). Right: the week's headline features
          // and a link to the week page, which lists every change.
          <>
            {weeks.map((week) => {
              const weekHref = `/changelog/${week.slug}`;
              return (
                <Band key={week.id} className="-mt-px first:mt-0">
                  <article id={week.slug} className="grid scroll-mt-24 grid-cols-1 lg:grid-cols-2">
                    <div className="flex flex-col gap-5 self-start px-6 pt-12 pb-8 lg:sticky lg:top-24 lg:px-11 lg:py-20">
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
                      <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl">
                        <Link
                          href={weekHref}
                          className="hover:text-muted-foreground focus-visible:text-muted-foreground transition-colors outline-none"
                        >
                          {week.headline}
                        </Link>
                      </h2>
                      <ul className="flex flex-col">
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

                    <div className="min-w-0 px-6 pb-12 lg:px-11 lg:py-20">
                      {week.summary ? (
                        <WeekSummary lines={week.summary} />
                      ) : week.highlights.length > 0 ? (
                        <ul className="space-y-6">
                          {week.highlights.map((highlight, i) => (
                            <li key={i}>
                              {highlight.title && (
                                <h3 className="text-foreground text-base font-medium">
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
                        <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-base">
                          {week.releases.map((release) => (
                            <li key={release.tag}>{release.headline}</li>
                          ))}
                        </ul>
                      )}
                      <div className="mt-10 flex items-center justify-between gap-4 text-sm">
                        <Link
                          href={weekHref}
                          className="text-foreground hover:text-ring focus-visible:text-ring w-fit transition-colors outline-none"
                        >
                          {tI18nComplete.raw('text1baa58fb1774')}
                        </Link>
                        <CopyLinkButton href={weekHref} className="-mr-3" />
                      </div>
                    </div>
                  </article>
                </Band>
              );
            })}
          </>
        )}
      </section>
    </PageFrame>
  );
}
