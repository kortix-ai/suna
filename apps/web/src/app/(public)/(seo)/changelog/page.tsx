import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { LocalTime } from '@/components/ui/local-time';

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
    url: 'https://www.kortix.com/changelog',
  },
  twitter: {
    card: 'summary',
    title: 'Kortix Changelog',
    description: 'Every Kortix release, straight from the source.',
  },
  alternates: { canonical: 'https://www.kortix.com/changelog' },
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

function ReleaseNotes({ body }: { body: string }) {
  return (
    <div
      className={
        'text-muted-foreground text-sm leading-relaxed break-words ' +
        '[&_a]:break-words [&_code]:break-words' +
        '[&_h1]:text-foreground [&_h1]:mt-6 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold' +
        '[&_h2]:text-foreground [&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold' +
        '[&_h3]:text-foreground [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-semibold' +
        '[&_p]:my-3' +
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5' +
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5' +
        '[&_li]:marker:text-muted-foreground/50' +
        '[&_a]:text-foreground [&_a]:decoration-foreground/20 hover:[&_a]:decoration-foreground/50 [&_a]:underline [&_a]:underline-offset-4' +
        '[&_code]:bg-muted [&_code]:text-foreground [&_code]:rounded-md [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em]' +
        '[&_pre]:bg-muted [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0' +
        '[&_strong]:text-foreground [&_strong]:font-medium' +
        '[&_img]:border-border/60 [&_img]:my-4 [&_img]:rounded-2xl [&_img]:border' +
        '[&_hr]:border-border/60 [&_hr]:my-6' +
        '[&_blockquote]:border-border [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:italic'
      }
    >
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
      <div className="mx-auto max-w-3xl px-6 pt-24 pb-24 sm:pt-32 sm:pb-32">
        {/* Hero */}
        <Reveal>
          <h1 className="text-foreground mb-3 text-3xl font-medium tracking-tight sm:text-4xl md:text-5xl">
            Changelog
          </h1>
          <p className="text-muted-foreground max-w-xl text-base leading-relaxed">
            {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextEveryReleaseStraight4acc5a00')}{' '}
            <a
              href={`https://github.com/${REPO}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground decoration-foreground/20 hover:decoration-foreground/50 underline underline-offset-4 transition-colors"
            >
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextViewOnGitHubfc7627d4')}
            </a>
            .
          </p>
        </Reveal>

        {/* Releases */}
        {releases.length === 0 ? (
          <div className="text-muted-foreground mt-16 text-sm">
            {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextCouldnTLoad69c0f1db')}{' '}
            <a
              href={`https://github.com/${REPO}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground decoration-foreground/20 hover:decoration-foreground/50 underline underline-offset-4"
            >
              {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextSeeTheFull556e8abb')}
            </a>
            .
          </div>
        ) : (
          // Single column with hairline dividers. NOTE: deliberately no per-release
          // Reveal/IntersectionObserver wrapper — a very long release body (v0.9.0
          // is ~60KB) is taller than the observer's threshold can ever satisfy, so
          // it would stay at opacity:0 forever and read as a huge blank gap.
          <div className="divide-border mt-12 divide-y sm:mt-16">
            {releases.map((release, i) => {
              const isLatest = i === 0 && !release.prerelease;
              // Huge auto-generated bodies (v0.9.0 is ~800 PR lines) would swallow
              // the whole page — clamp with a CSS-only fade and point to GitHub.
              const isLong = (release.body?.length ?? 0) > 6000;
              return (
                <article key={release.tag_name} className="py-10 first:pt-0 last:pb-0">
                  <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <h2 className="text-foreground text-xl font-medium tracking-tight">
                      {release.tag_name}
                    </h2>
                    {isLatest && (
                      <Badge size="sm" variant="highlight">
                        Latest
                      </Badge>
                    )}
                    {release.prerelease && (
                      <Badge size="sm" variant="outline">
                        Pre-release
                      </Badge>
                    )}
                    {release.published_at && (
                      <time
                        dateTime={release.published_at}
                        className="text-muted-foreground text-xs"
                      >
                        <LocalTime value={release.published_at} options={RELEASE_DATE_FORMAT} />
                      </time>
                    )}
                  </div>

                  {release.body?.trim() ? (
                    <div
                      className={
                        isLong
                          ? 'relative max-h-[34rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_72%,transparent)]'
                          : undefined
                      }
                    >
                      <ReleaseNotes body={release.body} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      {tI18nHardcoded.raw('autoAppPublicSeoChangelogPageJsxTextNoNotesFord9403c55')}
                    </p>
                  )}

                  <a
                    href={release.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground hover:text-foreground decoration-foreground/20 hover:decoration-foreground/50 mt-4 inline-block text-xs underline underline-offset-4 transition-colors"
                  >
                    {isLong ? 'Read the full release on GitHub →' : 'Release on GitHub →'}
                  </a>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
