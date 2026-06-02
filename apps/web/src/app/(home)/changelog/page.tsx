import type { Metadata } from 'next';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';

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

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function ReleaseNotes({ body }: { body: string }) {
  return (
    <div
      className={
        'text-sm leading-relaxed text-muted-foreground ' +
        '[&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-foreground [&_h1]:mt-6 [&_h1]:mb-2 ' +
        '[&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-6 [&_h2]:mb-2 ' +
        '[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-foreground [&_h3]:mt-5 [&_h3]:mb-2 ' +
        '[&_p]:my-3 ' +
        '[&_ul]:my-3 [&_ul]:space-y-1.5 [&_ul]:list-disc [&_ul]:pl-5 ' +
        '[&_ol]:my-3 [&_ol]:space-y-1.5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
        '[&_li]:marker:text-muted-foreground/50 ' +
        '[&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-foreground/20 hover:[&_a]:decoration-foreground/50 ' +
        '[&_code]:rounded-md [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_code]:text-foreground ' +
        '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-2xl [&_pre]:bg-muted [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
        '[&_strong]:text-foreground [&_strong]:font-medium ' +
        '[&_img]:rounded-2xl [&_img]:my-4 [&_img]:border [&_img]:border-border/60 ' +
        '[&_hr]:my-6 [&_hr]:border-border/60 ' +
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic'
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
  const releases = await getReleases();

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32 pb-24 sm:pb-32">
        {/* Hero */}
        <Reveal>
          <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground mb-3">
            Changelog
          </h1>
          <p className="text-base text-muted-foreground leading-relaxed max-w-xl">
            Every release, straight from the source. New features, fixes, and improvements —
            versioned and dated.{' '}
            <a
              href={`https://github.com/${REPO}/releases`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors"
            >
              View on GitHub
            </a>
            .
          </p>
        </Reveal>

        {/* Releases */}
        {releases.length === 0 ? (
          <Reveal delay={0.1}>
            <div className="mt-16 text-sm text-muted-foreground">
              Couldn&apos;t load releases right now.{' '}
              <a
                href={`https://github.com/${REPO}/releases`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50"
              >
                See the full changelog on GitHub
              </a>
              .
            </div>
          </Reveal>
        ) : (
          <div className="mt-14 sm:mt-20 space-y-16 sm:space-y-20">
            {releases.map((release, i) => {
              const isLatest = i === 0 && !release.prerelease;
              return (
                <Reveal key={release.tag_name} delay={Math.min(i, 3) * 0.05}>
                  <article className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-3 sm:gap-8">
                    {/* Left rail: version + date */}
                    <div className="sm:text-right">
                      <div className="flex items-center gap-2 sm:justify-end">
                        <h2 className="text-lg font-medium tracking-tight text-foreground">
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
                      </div>
                      <time className="mt-1 block text-xs text-muted-foreground">
                        {formatDate(release.published_at)}
                      </time>
                    </div>

                    {/* Right: notes */}
                    <div className="sm:border-l sm:border-border/60 sm:pl-8">
                      {release.body?.trim() ? (
                        <ReleaseNotes body={release.body} />
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          No notes for this release.
                        </p>
                      )}
                      <a
                        href={release.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-4 inline-block text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 decoration-foreground/20 hover:decoration-foreground/50 transition-colors"
                      >
                        Release on GitHub →
                      </a>
                    </div>
                  </article>
                </Reveal>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
