import { CANONICAL_ORIGIN } from '@/lib/site-metadata';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { Badge } from '@/components/ui/badge';
import { FadedScrollArea } from '@/components/ui/faded-scroll-area';
import { LocalTime } from '@/components/ui/local-time';
import { Separator } from '@/components/ui/separator';

import { Button } from '@/components/ui/marketing/button';
import Link from 'next/link';
import { CopyLinkButton } from './copy-link-button';
import { ArrowRightIcon } from '@/features/icon/arrow-right';

const RELEASE_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
};

export const metadata: Metadata = {
  title: 'Changelog',
  description:
    'Every Kortix release, straight from the source. New features, fixes, and improvements — versioned and dated.',
  openGraph: {
    title: 'Kortix Changelog',
    description: 'Every Kortix release, straight from the source.',
    url: `${CANONICAL_ORIGIN}/changelog`,
    siteName: 'Kortix',
    type: 'website',
    images: [{ url: '/banner.png', width: 1200, height: 630, alt: 'Kortix Changelog' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Kortix Changelog',
    description: 'Every Kortix release, straight from the source.',
    images: ['/banner.png'],
  },
  alternates: { canonical: `${CANONICAL_ORIGIN}/changelog` },
};

// Rebuild hourly so new releases show up without a deploy.
export const revalidate = 3600;

const REPO = 'kortix-ai/suna';

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
}

// Only real, published version releases — never the mutable dev-latest /
// desktop-dev-latest prereleases or drafts.
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

// Release names read "v0.12.8 — Entitlement overrides, act-as support sessions".
// The version already headlines its own line, so strip it rather than print it
// twice; a name that is nothing but the version falls back to the tag.
const NAME_VERSION_PREFIX = /^v\d+\.\d+\.\d+\s*(?:[—–-]\s*)?/;

async function getReleases(): Promise<GitHubRelease[]> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kortix-web',
  };
  // Optional — lifts the 60/hr unauthenticated rate limit if a token is set.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
      headers,
      next: { revalidate },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as GitHubRelease[];
    return (data ?? [])
      .filter((r) => !r.draft && SEMVER_TAG.test(r.tag_name))
      .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  } catch {
    return [];
  }
}

function releaseHeadline(release: GitHubRelease): string {
  const name = release.name?.trim();
  if (!name) return release.tag_name;
  return name.replace(NAME_VERSION_PREFIX, '').trim() || release.tag_name;
}

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

function ReleaseNotes({ body }: { body: string }) {
  return (
    <div className={RELEASE_PROSE}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

export default async function ChangelogPage() {
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const releases = await getReleases();

  return (
    <main className="bg-background min-h-screen">
      <div className="mx-auto max-w-6xl px-6 pb-24 sm:pb-32">
        <header className="pt-28 pb-16 sm:pt-36 sm:pb-28">
          <h1 className="text-3xl font-medium text-balance md:text-4xl lg:tracking-tight">
            Changelog
          </h1>
        </header>

        {releases.length === 0 ? (
          <div>
            <Separator />
            <p className="text-muted-foreground pt-10 text-sm">
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextCouldnTLoad69c0f1db')}{' '}
              <a
                href={`https://github.com/${REPO}/releases`}
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
            {releases.map((release, i) => {
              const isLatest = i === 0 && !release.prerelease;
              // Huge auto-generated bodies (v0.9.0 is ~800 PR lines) would swallow
              // the whole page — clamp in FadedScrollArea and point to GitHub.
              const isLong = (release.body?.length ?? 0) > 6000;
              return (
                <article key={release.tag_name} id={release.tag_name} className="scroll-mt-24">
                  <Separator />
                  <div className="py-14 sm:py-20">
                    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-2">
                      <div className="self-start lg:sticky lg:top-24">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          {release.published_at ? (
                            <time
                              dateTime={release.published_at}
                              className="text-muted-foreground text-sm tabular-nums"
                            >
                              <LocalTime
                                value={release.published_at}
                                options={RELEASE_DATE_FORMAT}
                              />
                            </time>
                          ) : null}
                          <CopyLinkButton anchor={release.tag_name} />
                        </div>
                        <h2 className="text-foreground mt-3 text-2xl font-medium tracking-tight text-balance sm:text-3xl">
                          {releaseHeadline(release)}
                        </h2>
                        <div className="mt-5 flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground font-mono text-xs tracking-wide">
                            {release.tag_name}
                          </span>
                          {isLatest && (
                            <Badge size="sm" variant="kortix" className='rounded'>
                              Latest
                            </Badge>
                          )}
                          {release.prerelease && (
                            <Badge size="sm" variant="kortix" className='rounded'>
                              Pre-release
                            </Badge>
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 space-y-8">
                        {release.body?.trim() ? (
                          isLong ? (
                            <FadedScrollArea
                              fadeColor="from-background"
                              fadeSize="16"
                              rootClassName="h-auto max-h-[34rem]"
                              className="max-h-[34rem] overscroll-contain"
                            >
                              <ReleaseNotes body={release.body} />
                            </FadedScrollArea>
                          ) : (
                            <ReleaseNotes body={release.body} />
                          )
                        ) : (
                          <p className="text-muted-foreground text-[15px]">
                            {tI18nHardcoded.raw(
                              'autoAppPublicSeoChangelogPageJsxTextNoNotesFord9403c55',
                            )}
                          </p>
                        )}

                        <Button asChild variant="ghost" className='group/arrow-right'>
                          <Link href={release.html_url} target="_blank" rel="noopener noreferrer">
                            {isLong ? 'Read the full release on GitHub' : 'Release on GitHub'}

<ArrowRightIcon  />

                          </Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
