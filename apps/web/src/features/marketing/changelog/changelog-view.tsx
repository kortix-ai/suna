import { getTranslations } from '@/i18n/get-translations';

import { Button } from '@/components/ui/marketing/button';
import { ArrowRightIcon } from '@/features/icon/arrow-right';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { FadedScrollArea } from '@kortix/ui/faded-scroll-area';
import { LocalTime } from '@kortix/ui/local-time';
import Link from 'next/link';

import { ChangelogAnchorRedirect } from './anchor-redirect';
import { CopyLinkButton } from './copy-link-button';
import { changelogPageHref } from './paging';
import { CHANGELOG_REPO } from './releases';
import type { ChangelogPage } from './types';

/** Hero lines under "Release history". English until they have keys. */
const RELEASES_MUTED = 'Every production release.';
const RELEASES_SUB = 'The full notes for each version of Kortix, newest first.';

const RELEASE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

/**
 * Prose scale for a GitHub release body.
 *
 * Joined with spaces, never concatenated: `'…a' + '[&_h1]:…'` glues two
 * candidates into one unparseable class, which is how every rule below the
 * first line silently stopped applying before this rewrite.
 */
const RELEASE_PROSE = [
  'text-muted-foreground text-base wrap-break-word text-pretty',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_a]:wrap-break-word [&_code]:wrap-break-word',
  '[&_h1]:text-foreground [&_h1]:mt-10 [&_h1]:mb-3 [&_h1]:text-base [&_h1]:font-medium',
  '[&_h2]:text-foreground [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-base [&_h2]:font-medium',
  '[&_h3]:text-foreground [&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-medium',
  '[&_p]:my-4',
  '[&_ul]:my-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5',
  '[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5',
  '[&_li]:marker:text-muted-foreground',
  // `[&_a:hover]`, not `hover:[&_a]` — the latter compiles to `.prose:hover a`,
  // so hovering anywhere in the body would light up every link at once.
  '[&_a]:text-foreground [&_a]:decoration-foreground/25 [&_a:hover]:decoration-foreground/60',
  '[&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors',
  // `#1234` pull request links (render.ts): always the ring blue, no underline;
  // the underline comes back on hover.
  '[&_a[data-pr]]:text-ring [&_a[data-pr]]:no-underline [&_a[data-pr]:hover]:underline',
  '[&_code]:bg-muted [&_code]:text-foreground [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em]',
  '[&_pre]:bg-muted [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-4',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_strong]:text-foreground [&_strong]:font-medium',
  '[&_img]:border-border/60 [&_img]:my-5 [&_img]:rounded-md [&_img]:border',
  '[&_hr]:border-border/60 [&_hr]:my-8',
  '[&_blockquote]:border-border [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:italic',
].join(' ');

/** Notes arrive as sanitized HTML rendered once per cache fill (see render.ts).
 *  A single HTML string is also far smaller in the RSC payload than the element
 *  tree `<ReactMarkdown>` produced. */
export function ReleaseNotes({ html }: { html: string }) {
  return <div className={RELEASE_PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Page links under the last release. Plain crawlable anchors, so every release
 * stays reachable for search engines and readers without JavaScript.
 */
async function ChangelogPagination({ page, pageCount }: { page: number; pageCount: number }) {
  if (pageCount <= 1) return null;
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  return (
    <nav aria-label={tI18nComplete.raw('textf952fee736ed')} className="px-8 pt-12 lg:px-28">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          {page > 1 ? (
            <Button asChild variant="ghost">
              <Link href={changelogPageHref(page - 1)} rel="prev">
                {tI18nComplete.raw('texta57b08a480b8')}
              </Link>
            </Button>
          ) : null}
        </div>
        <ol className="hidden items-center gap-1 sm:flex">
          {pages.map((n) => (
            <li key={n}>
              <Link
                href={changelogPageHref(n)}
                aria-current={n === page ? 'page' : undefined}
                className={cn(
                  'text-muted-foreground hover:text-foreground hover:bg-hover duration-fast flex size-9 items-center justify-center rounded-md text-sm tabular-nums transition-colors',
                  n === page && 'bg-active text-foreground',
                )}
              >
                {n}
              </Link>
            </li>
          ))}
        </ol>
        <div className="min-w-0">
          {page < pageCount ? (
            <Button asChild variant="ghost" className="group/arrow-right">
              <Link href={changelogPageHref(page + 1)} rel="next">
                {tI18nComplete.raw('text1ff57a29d7c9')}
                <ArrowRightIcon />
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

export async function ChangelogView({ data }: { data: ChangelogPage }) {
  const [tI18nComplete, tI18nHardcoded] = await Promise.all([
    getTranslations('hardcodedUi.i18nComplete'),
    getTranslations('hardcodedUi'),
  ]);
  const { releases, page, pageCount, tagPages } = data;

  return (
    <PageFrame>
      <ChangelogAnchorRedirect page={page} tagPages={tagPages} />
      <PageHero
        title={tI18nComplete.raw('textf952fee736ed')}
        titleMuted={RELEASES_MUTED}
        sub={RELEASES_SUB}
        actions={
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
            <Link href="/changelog">{tI18nComplete.raw('textead07c84baac')}</Link>
          </MarketingButton>
        }
      />

      <section className="pb-20 lg:pb-28">
        {releases.length === 0 ? (
          <Band>
            <p className="text-muted-foreground px-6 py-10 text-sm lg:px-11">
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextCouldnTLoad69c0f1db')}{' '}
              <a
                href={`https://github.com/${CHANGELOG_REPO}/releases`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground decoration-foreground/25 hover:decoration-foreground/60 underline underline-offset-4 transition-colors"
              >
                {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextSeeTheFull556e8abb')}
              </a>
              .
            </p>
          </Band>
        ) : (
          // One band per release, so every hairline crosses the page. Left is a sticky identity
          // stack (date + copy, headline, version); right, the notes. Date sits above the title: a sticky column that
          // stretches to the notes height cannot pin, so mt-auto never lands.
          // NOTE: deliberately no per-release Reveal wrapper — a very long body
          // (v0.9.0 is ~60KB) is taller than the IntersectionObserver threshold
          // can ever satisfy, so it would stay at opacity:0 forever.
          <>
            {releases.map((release) => (
              <Band key={release.tag} className="-mt-px first:mt-0">
                <article id={release.tag} className="grid scroll-mt-24 grid-cols-1 lg:grid-cols-2">
                  <div className="self-start px-6 pt-12 pb-8 lg:sticky lg:top-24 lg:px-11 lg:py-20">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {release.publishedAt ? (
                        <time
                          dateTime={release.publishedAt}
                          className="text-muted-foreground text-sm tabular-nums"
                        >
                          <LocalTime value={release.publishedAt} options={RELEASE_DATE_FORMAT} />
                        </time>
                      ) : null}
                      <CopyLinkButton anchor={release.tag} />
                    </div>
                    <h2 className="text-foreground mt-3 text-xl font-medium tracking-tight text-balance md:text-2xl">
                      {release.headline}
                    </h2>
                    <div className="mt-5 flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground font-mono text-xs">{release.tag}</span>
                      {release.isLatest && (
                        <Badge size="sm" variant="kortix" className="rounded">
                          {tI18nComplete.raw('text8730d3c2022a')}
                        </Badge>
                      )}
                      {release.prerelease && (
                        <Badge size="sm" variant="kortix" className="rounded">
                          {tI18nComplete.raw('texta90d2f735a49')}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-col items-start gap-6 px-6 pb-12 lg:px-11 lg:py-20">
                    {release.html ? (
                      release.isLong ? (
                        <FadedScrollArea
                          fadeColor="from-background"
                          fadeSize="16"
                          rootClassName="h-auto max-h-[34rem] w-full"
                          className="max-h-[34rem] overscroll-contain"
                        >
                          <ReleaseNotes html={release.html} />
                        </FadedScrollArea>
                      ) : (
                        <ReleaseNotes html={release.html} />
                      )
                    ) : (
                      <p className="text-muted-foreground text-base">
                        {tI18nHardcoded.raw(
                          'autoAppPublicSeoChangelogPageJsxTextNoNotesFord9403c55',
                        )}
                      </p>
                    )}

                    <a
                      href={release.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-foreground hover:text-ring focus-visible:text-ring text-sm transition-colors outline-none"
                    >
                      {release.isLong
                        ? tI18nComplete.raw('text21613c68434c')
                        : tI18nComplete.raw('textd3dc01b4e53e')}
                    </a>
                  </div>
                </article>
              </Band>
            ))}
            <ChangelogPagination page={page} pageCount={pageCount} />
          </>
        )}
      </section>
    </PageFrame>
  );
}
