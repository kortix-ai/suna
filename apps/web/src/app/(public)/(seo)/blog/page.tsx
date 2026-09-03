import type { Metadata } from 'next';
import { useTranslations } from 'next-intl';

import { PostCard } from '@/components/blog/post-card';
import { Reveal } from '@/components/home/reveal';
import { EmptyState } from '@/features/layout/section/empty-state';
import { getAllPosts } from '@/lib/blog';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@/lib/site-metadata';

const TITLE = 'Blog';
const DESCRIPTION =
  'Field notes on building, running, and governing AI agents that do real work — from the team building the Kortix command center.';
const URL = `${siteMetadata.url}/blog`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: ['Kortix blog', 'AI agents', 'AI command center', 'AI workforce', 'agent automation'],
  openGraph: {
    type: 'website',
    title: `Kortix ${TITLE}`,
    description: DESCRIPTION,
    url: URL,
    siteName: 'Kortix',
    images: [{ url: `${siteMetadata.url}/banner.png` }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Kortix ${TITLE}`,
    description: DESCRIPTION,
    images: [`${siteMetadata.url}/banner.png`],
  },
  alternates: {
    canonical: URL,
    types: { 'application/rss+xml': `${URL}/rss.xml` },
  },
};

export default function BlogIndexPage() {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const posts = getAllPosts();
  const [featured, ...rest] = posts;

  // Blog + ItemList structured data so search engines understand the listing.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Blog',
    name: 'Kortix Blog',
    description: DESCRIPTION,
    url: URL,
    publisher: {
      '@type': 'Organization',
      name: 'Kortix',
      logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.svg` },
    },
    blogPost: posts.map((post) => ({
      '@type': 'BlogPosting',
      headline: post.data.title,
      description: post.data.description,
      datePublished: post.data.date,
      author: { '@type': 'Person', name: post.author.name },
      url: `${siteMetadata.url}${post.url}`,
    })),
  };

  return (
    <main className="bg-background min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />
      <div className="mx-auto max-w-7xl px-6 pt-28 pb-24 sm:pt-40 sm:pb-32">
        {/* The deck is capped at max-w-2xl so it reads as a sentence rather
            than a line stretched across the full listing width. */}
        <Reveal className="max-w-2xl">
          <h1 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
            {TITLE}
          </h1>
          <p className="text-muted-foreground mt-5 text-base leading-relaxed sm:text-lg">
            {DESCRIPTION}
          </p>
        </Reveal>

        {posts.length === 0 ? (
          <div className="mt-16">
            <EmptyState
              title={tI18nHardcoded.raw('autoAppPublicSeoBlogPageJsxAttrTitleNoPosts340caa81')}
              description={tI18nHardcoded.raw(
                'autoAppPublicSeoBlogPageJsxAttrDescriptionWeRecebec139',
              )}
            />
          </div>
        ) : (
          <div className="mt-14 sm:mt-20">
            <Reveal>
              <PostCard post={featured} featured />
            </Reveal>

            {rest.length > 0 && (
              // One hairline separates the lead from the archive — the only
              // rule on the page, so it reads as structure rather than chrome.
              <div className="border-border/60 mt-14 border-t pt-14 sm:mt-16 sm:pt-16">
                <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-3">
                  {rest.map((post, i) => (
                    <Reveal key={post.slug} delay={Math.min(i * 0.05, 0.2)}>
                      <PostCard post={post} />
                    </Reveal>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
