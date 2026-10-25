import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { BlogCover } from '@/components/blog/blog-cover';
import { BlogMarkdown } from '@/components/blog/blog-markdown';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { formatPostDate, resolveAuthor } from '@/lib/blog';
import { getAllPosts, getPostEntry, type BlogPostEntry } from '@/lib/blog-posts';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@/lib/site-metadata';
import { cn } from '@/lib/utils';

const BLOG_URL = `${siteMetadata.url}/blog`;

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const entry = getPostEntry(slug);
  if (!entry) return {};
  // A post published first on another site keeps that page as its canonical.
  const url = entry.canonical ?? `${BLOG_URL}/${slug}`;
  const ogImage = entry.cover ? `${siteMetadata.url}${entry.cover}` : `${siteMetadata.url}/banner.png`;
  const author = resolveAuthor(entry.author);
  return {
    title: entry.title,
    description: entry.description,
    keywords: entry.tags.length ? entry.tags : undefined,
    authors: [{ name: author.name }],
    openGraph: {
      type: 'article',
      title: entry.title,
      description: entry.description,
      url,
      siteName: 'Kortix',
      publishedTime: entry.date,
      modifiedTime: entry.updated ?? entry.date,
      authors: [author.name],
      tags: entry.tags,
      images: [{ url: ogImage, width: 1200, height: 630, alt: entry.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: entry.title,
      description: entry.description,
      images: [ogImage],
    },
    alternates: {
      canonical: url,
      types: { 'application/rss+xml': `${BLOG_URL}/rss.xml` },
    },
  };
}

/**
 * A post's lead visual when it has real product footage: muted, looping,
 * inline, poster-first — and under `prefers-reduced-motion` the poster as a
 * still instead of the video.
 */
function PostLeadMedia({
  media,
  className,
}: {
  media: NonNullable<BlogPostEntry['leadMedia']>;
  className?: string;
}) {
  return (
    <div className={cn('relative overflow-hidden', className)} style={{ aspectRatio: media.aspectRatio }}>
      <video
        className="h-full w-full object-cover motion-reduce:hidden"
        poster={media.poster}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={media.alt}
      >
        {media.sources.map((source) => (
          <source key={source.src} src={source.src} type={source.type} />
        ))}
      </video>
      {/* eslint-disable-next-line @next/next/no-img-element -- poster still for reduced motion */}
      <img
        src={media.poster}
        alt={media.alt}
        className="absolute inset-0 hidden h-full w-full object-cover motion-reduce:block"
      />
    </div>
  );
}

/**
 * A post, after Buio's blog post layout (Lexington-Themes/buio): title and
 * deck, a wide lead visual, then a sticky facts column beside the article,
 * which takes the other three of four columns.
 */
export default async function BlogPostPage(props: PageProps) {
  const { slug } = await props.params;
  const entry = getPostEntry(slug);
  if (!entry) notFound();
  if (entry.draft && process.env.NODE_ENV === 'production') notFound();

  const author = resolveAuthor(entry.author);
  const postUrl = entry.canonical ?? `${BLOG_URL}/${slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: entry.title,
        description: entry.description,
        datePublished: entry.date,
        dateModified: entry.updated ?? entry.date,
        keywords: entry.tags,
        timeRequired: `PT${entry.readingTime}M`,
        author: { '@type': 'Person', name: author.name },
        publisher: {
          '@type': 'Organization',
          name: 'Kortix',
          logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.svg` },
        },
        image: entry.cover ? `${siteMetadata.url}${entry.cover}` : `${siteMetadata.url}/banner.png`,
        url: postUrl,
        mainEntityOfPage: postUrl,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Blog', item: BLOG_URL },
          { '@type': 'ListItem', position: 2, name: entry.title, item: postUrl },
        ],
      },
    ],
  };

  return (
    <main className="bg-background relative min-h-screen pt-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }} />
      <section>
        <div className={cn(MARKETING_CONTAINER, 'pt-24 pb-24 md:pt-30 md:pb-30')}>
          <div className="max-w-4xl">
            <h1 className="text-foreground text-3xl font-medium tracking-tight text-balance md:text-4xl lg:text-5xl">
              {entry.title}
            </h1>
            {entry.description && (
              <p className="text-muted-foreground mt-6 max-w-2xl text-base text-balance">{entry.description}</p>
            )}
          </div>
          {entry.leadMedia ? (
            <PostLeadMedia media={entry.leadMedia} className="bg-muted mt-16 w-full" />
          ) : (
            <BlogCover
              logos={entry.coverLogos ?? []}
              withKortix={entry.coverKortix ?? true}
              className="bg-muted mt-16 aspect-[2/1] w-full"
            />
          )}
          <div className="mt-16 grid grid-cols-1 gap-12 lg:grid-cols-4">
            <dl className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
              <div>
                <dt className="text-muted-foreground text-sm">Written by</dt>
                <dd className="text-foreground mt-1 text-sm">{author.name}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-sm">Published</dt>
                <dd className="text-foreground mt-1 text-sm">
                  <time dateTime={entry.date}>{formatPostDate(entry.date)}</time>
                </dd>
              </div>
              {entry.tags.length > 0 && (
                <div>
                  <dt className="text-muted-foreground text-sm">Topics</dt>
                  <dd className="text-foreground mt-1 text-sm">{entry.tags.join(', ')}</dd>
                </div>
              )}
            </dl>
            <article className="min-w-0 lg:col-span-3 [&>div:first-child]:mt-0">
              <BlogMarkdown lead={entry.lead} body={entry.body} />
            </article>
          </div>
        </div>
      </section>
    </main>
  );
}
