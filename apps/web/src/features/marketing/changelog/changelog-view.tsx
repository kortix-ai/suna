import { getTranslations } from '@/i18n/get-translations';

import { Badge } from '@/components/ui/badge';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { LocalTime } from '@/components/ui/local-time';
import { Button } from '@/components/ui/marketing/button';
import { Separator } from '@/components/ui/separator';
import { ArrowRightIcon } from '@/features/icon/arrow-right';
import { cn } from '@/lib/utils';
import Link from 'next/link';

import { CopyLinkButton } from './copy-link-button';
import { ChangelogAnchorRedirect } from './anchor-redirect';
import { CHANGELOG_REPO } from './releases';
import { changelogPageHref } from './paging';
import type { ChangelogPage } from './types';

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
  'text-muted-foreground text-[15px] leading-7 wrap-break-word text-pretty',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_a]:wrap-break-word [&_code]:wrap-break-word',
  '[&_h1]:text-foreground [&_h1]:mt-10 [&_h1]:mb-3 [&_h1]:text-base [&_h1]:font-medium',
  '[&_h2]:text-foreground [&_h2]:mt-10 [&_h2]:mb-3 [&_h2]:text-base [&_h2]:font-medium',
  '[&_h3]:text-foreground [&_h3]:mt-8 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-medium',
  '[&_p]:my-4',
  '[&_ul]:my-4 [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-5',
  '[&_ol]:my-4 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-5',
  '[&_li]:marker:text-muted-foreground/40',
  // `[&_a:hover]`, not `hover:[&_a]` — the latter compiles to `.prose:hover a`,
  // so hovering anywhere in the body would light up every link at once.
  '[&_a]:text-foreground [&_a]:decoration-foreground/25 [&_a:hover]:decoration-foreground/60',
  '[&_a]:underline [&_a]:underline-offset-4 [&_a]:transition-colors',
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
    <nav aria-label={tI18nComplete.raw('textead07c84baac')}>
      <Separator />
      <div className="flex items-center justify-between gap-4 py-14 sm:py-20">
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
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const { releases, page, pageCount, tagPages } = data;

  return (
    <main className="bg-background min-h-screen">
      <ChangelogAnchorRedirect page={page} tagPages={tagPages} />
      <div className="mx-auto max-w-6xl px-6 pb-24 sm:pb-32">
        <header className="pt-28 pb-16 sm:pt-36 sm:pb-28">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            {tI18nComplete.raw('textead07c84baac')}
          </h1>
        </header>

        {releases.length === 0 ? (
          <div>
            <Separator />
            <p className="text-muted-foreground pt-10 text-sm">
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
          </div>
        ) : (
          // Each release: hairline, then a 2-col split. Left is a sticky identity
          // stack — date + copy as the eyebrow, then headline, then version.
          // Right is the notes. Date sits above the title (Linear / Notion /
          // GitBook), not as a footer: a sticky column that stretches to the
          // notes height cannot pin, so mt-auto never lands where it looks.
          // NOTE: deliberately no per-release Reveal wrapper
          // — a very long body (v0.9.0 is ~60KB) is taller than the
          // IntersectionObserver threshold can ever satisfy, so it would stay at
          // opacity:0 forever and read as a huge blank gap.
          <div>
            {releases.map((release) => (
              <article key={release.tag} id={release.tag} className="scroll-mt-24">
                <Separator />
                <div className="py-14 sm:py-20">
                  <div className="grid gap-x-16 gap-y-8 lg:grid-cols-2">
                    <div className="self-start lg:sticky lg:top-24">
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
                      <h2 className="text-foreground mt-3 text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                        {release.headline}
                      </h2>
                      <div className="mt-5 flex flex-wrap items-center gap-2">
                        <span className="text-muted-foreground font-mono text-xs tracking-wide">
                          {release.tag}
                        </span>
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

                    <div className="min-w-0 space-y-8">
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
                        <p className="text-muted-foreground text-[15px]">
                          {tI18nHardcoded.raw(
                            'autoAppPublicSeoChangelogPageJsxTextNoNotesFord9403c55',
                          )}
                        </p>
                      )}

                      <Button asChild variant="ghost" className="group/arrow-right">
                        <a href={release.htmlUrl} target="_blank" rel="noopener noreferrer">
                          {release.isLong
                            ? tI18nComplete.raw('text21613c68434c')
                            : tI18nComplete.raw('textd3dc01b4e53e')}

                          <ArrowRightIcon />
                        </a>
                      </Button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
            <ChangelogPagination page={page} pageCount={pageCount} />
          </div>
        )}
      </div>
    </main>
  );
}
