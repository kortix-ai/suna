import { getTranslations } from '@/i18n/get-translations';

import { Badge } from '@/components/ui/badge';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { LocalTime } from '@/components/ui/local-time';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { SectionHeading } from '@/features/marketing/kit/section-heading';
import { cn } from '@/lib/utils';
import Link from 'next/link';

import { ChangelogAnchorRedirect } from './anchor-redirect';
import { CopyLinkButton } from './copy-link-button';
import { changelogPageHref } from './paging';
import { CHANGELOG_REPO } from './releases';
import type { ChangelogPage } from './types';


const RELEASE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

/** Ink link; hover dims it to muted (Buio). */
const TEXT_LINK =
  'text-foreground hover:text-muted-foreground duration-moderate hit-area-y-3 transition-colors';

/**
 * Prose scale for a GitHub release body (Buio's prose: muted body, ink
 * headings, strong and links).
 *
 * Joined with spaces, never concatenated: `'…a' + '[&_h1]:…'` glues two
 * candidates into one unparseable class, which is how every rule below the
 * first line silently stopped applying before.
 */
const RELEASE_PROSE = [
  'text-muted-foreground text-base leading-7 wrap-break-word text-pretty',
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
  '[&_a]:text-foreground [&_a]:decoration-border [&_a:hover]:decoration-foreground',
  '[&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors',
  '[&_code]:bg-muted [&_code]:text-foreground [&_code]:rounded-sm [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm',
  '[&_pre]:border-border [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:p-4',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_strong]:text-foreground [&_strong]:font-medium',
  '[&_img]:border-border [&_img]:my-6 [&_img]:border',
  '[&_hr]:border-border [&_hr]:my-8',
  '[&_blockquote]:border-border [&_blockquote]:border-l [&_blockquote]:pl-4',
].join(' ');

/** Notes arrive as sanitized HTML rendered once per cache fill (see render.ts).
 *  A single HTML string is also far smaller in the RSC payload than the element
 *  tree `<ReactMarkdown>` produced. */
function ReleaseNotes({ html }: { html: string }) {
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
    <nav
      aria-label={tI18nComplete.raw('textead07c84baac')}
      className="mt-12 grid grid-cols-2 items-center gap-y-6 lg:grid-cols-4"
    >
      <div className="lg:order-2 lg:col-span-2">
        <ol className="flex flex-wrap items-center">
          {pages.map((n) => (
            <li key={n}>
              <Link
                href={changelogPageHref(n)}
                aria-current={n === page ? 'page' : undefined}
                className={cn(
                  'outline-ring flex size-12 items-center justify-center text-sm tabular-nums',
                  'duration-moderate transition-colors focus-visible:outline-2',
                  n === page ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {n}
              </Link>
            </li>
          ))}
        </ol>
      </div>
      <div className="col-span-2 flex gap-2 lg:order-3 lg:col-span-1 lg:justify-end">
        {page > 1 ? (
          <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
            <Link href={changelogPageHref(page - 1)} rel="prev">
              {tI18nComplete.raw('texta57b08a480b8')}
            </Link>
          </MarketingButton>
        ) : null}
        {page < pageCount ? (
          <MarketingButton size="md" className="hit-area-y-1" variant="secondary" asChild>
            <Link href={changelogPageHref(page + 1)} rel="next">
              {tI18nComplete.raw('text1ff57a29d7c9')}
            </Link>
          </MarketingButton>
        ) : null}
      </div>
    </nav>
  );
}

/**
 * The changelog (Buio's changelog list): a two-tone page header, then one
 * hairline row per release on the shared 4-column grid. Column 1 holds the
 * date, version and copy-link and pins while its notes scroll past; columns
 * 2–3 hold the headline and the notes; column 4 stays empty, as in Buio.
 *
 * No per-release reveal: a long body (v0.9.0 is ~60KB) is taller than any
 * IntersectionObserver threshold, so it would never fade in.
 */
export async function ChangelogView({ data }: { data: ChangelogPage }) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const { releases, page, pageCount, tagPages } = data;

  return (
    <main className="bg-background min-h-screen pt-16">
      <ChangelogAnchorRedirect page={page} tagPages={tagPages} />
      <div className={cn(MARKETING_CONTAINER, 'pb-24 md:pb-30')}>
        <SectionHeading
          as="h1"
          className="pt-24 md:pt-30"
          title={`${tI18nComplete.raw('textead07c84baac')}.`}
          titleMuted="Every release, newest first."
          description="Release notes from the open-source repository on GitHub, versioned and dated."
        />

        {releases.length === 0 ? (
          <p className="text-muted-foreground border-border mt-16 border-t pt-8 text-sm text-pretty">
            {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextCouldnTLoad69c0f1db')}{' '}
            <a
              href={`https://github.com/${CHANGELOG_REPO}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              className={TEXT_LINK}
            >
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextSeeTheFull556e8abb')}
            </a>
            .
          </p>
        ) : (
          <>
            <ol className="border-border mt-16 border-b">
              {releases.map((release) => (
                <li
                  key={release.tag}
                  id={release.tag}
                  className="border-border grid scroll-mt-16 grid-cols-1 gap-y-6 border-t py-12 lg:grid-cols-4"
                >
                  <div className="flex flex-col items-start gap-3 lg:sticky lg:top-24 lg:self-start lg:pr-8">
                    {release.publishedAt ? (
                      <time
                        dateTime={release.publishedAt}
                        className="text-muted-foreground text-sm tabular-nums"
                      >
                        <LocalTime value={release.publishedAt} options={RELEASE_DATE_FORMAT} />
                      </time>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground text-sm tabular-nums">{release.tag}</span>
                      {release.isLatest ? (
                        <Badge size="sm" variant="kortix">
                          {tI18nComplete.raw('text8730d3c2022a')}
                        </Badge>
                      ) : null}
                      {release.prerelease ? (
                        <Badge size="sm" variant="outline">
                          {tI18nComplete.raw('texta90d2f735a49')}
                        </Badge>
                      ) : null}
                    </div>
                    <CopyLinkButton anchor={release.tag} />
                  </div>

                  <article className="min-w-0 lg:col-span-2 lg:pr-8">
                    <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
                      {release.headline}
                    </h2>
                    <div className="mt-8">
                      {release.html ? (
                        release.isLong ? (
                          <FadedScrollArea
                            fadeColor="from-background"
                            fadeSize="16"
                            rootClassName="h-auto max-h-[34rem]"
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
                    </div>
                    <a
                      href={release.htmlUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(TEXT_LINK, 'mt-6 inline-block text-sm')}
                    >
                      {release.isLong
                        ? tI18nComplete.raw('text21613c68434c')
                        : tI18nComplete.raw('textd3dc01b4e53e')}
                    </a>
                  </article>
                </li>
              ))}
            </ol>
            <ChangelogPagination page={page} pageCount={pageCount} />
          </>
        )}
      </div>
    </main>
  );
}
