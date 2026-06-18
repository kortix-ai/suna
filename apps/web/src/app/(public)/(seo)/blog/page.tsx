import type { Metadata } from 'next';

import { Reveal } from '@/components/home/reveal';
import { PostCard } from '@/components/blog/post-card';
import { EmptyState } from '@/components/ui/empty-state';
import { getAllPosts } from '@/lib/blog';
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
      logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.png` },
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
    <main className="min-h-screen bg-background">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="mx-auto max-w-5xl px-6 pt-24 pb-24 sm:pt-32 sm:pb-32">
        <Reveal>
          <h1 className="mb-3 text-3xl font-medium tracking-tight text-foreground sm:text-4xl md:text-5xl">
            {TITLE}
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
            {DESCRIPTION}
          </p>
        </Reveal>

        {posts.length === 0 ? (
          <div className="mt-16">
            <EmptyState
              title="No posts yet"
              description="We're writing the first one. Check back soon."
            />
          </div>
        ) : (
          <div className="mt-12 sm:mt-16">
            <Reveal>
              <PostCard post={featured} featured />
            </Reveal>

            {rest.length > 0 && (
              <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
                {rest.map((post, i) => (
                  <Reveal key={post.slug} delay={Math.min(i * 0.05, 0.2)}>
                    <PostCard post={post} />
                  </Reveal>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
