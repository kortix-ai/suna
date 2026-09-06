import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';

import { BlogContent } from '@/components/blog/blog-content';
import { BlogCover } from '@/components/blog/blog-cover';
import { PostByline } from '@/components/blog/post-byline';
import { PostCard } from '@/components/blog/post-card';
import { getAllPosts, getPostEntry, resolveAuthor } from '@/lib/blog';
import type { BlogPostEntry } from '@/lib/blog-posts';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@/lib/site-metadata';
import { cn } from '@/lib/utils';

/**
 * A post's lead visual when it has real product footage to lead with, in place
 * of the generated `BlogCover` lockup. Same treatment as the landing hero:
 * muted, looping, inline, poster-first — and under `prefers-reduced-motion` the
 * video is hidden and the poster renders as a still instead.
 */
function PostLeadMedia({
  media,
  className,
}: {
  media: NonNullable<BlogPostEntry['leadMedia']>;
  className?: string;
}) {
  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={{ aspectRatio: media.aspectRatio }}
    >
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
      <Image
        src={media.poster}
        alt={media.alt}
        fill
        sizes="(max-width: 768px) 100vw, 768px"
        className="hidden object-cover motion-reduce:block"
      />
    </div>
  );
}

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

  const url = `${siteMetadata.url}/blog/${slug}`;
  const ogImage = entry.cover
    ? `${siteMetadata.url}${entry.cover}`
    : `${siteMetadata.url}/banner.png`;
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
      modifiedTime: entry.date,
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
      types: { 'application/rss+xml': `${siteMetadata.url}/blog/rss.xml` },
    },
  };
}

export default async function BlogPostPage(props: PageProps) {
  const { slug } = await props.params;
  const entry = getPostEntry(slug);
  if (!entry) notFound();
  if (entry.draft && process.env.NODE_ENV === 'production') notFound();

  const author = resolveAuthor(entry.author);
  // The first tag is the post's topic and leads the header as an eyebrow; the
  // rest are navigation and render at the foot of the article.
  const topic = entry.tags[0];
  const more = getAllPosts()
    .filter((p) => p.slug !== slug)
    .slice(0, 2);

  const postUrl = `${siteMetadata.url}/blog/${slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: entry.title,
        description: entry.description,
        datePublished: entry.date,
        dateModified: entry.date,
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
          { '@type': 'ListItem', position: 1, name: 'Blog', item: `${siteMetadata.url}/blog` },
          { '@type': 'ListItem', position: 2, name: entry.title, item: postUrl },
        ],
      },
    ],
  };

  return (
    <main className="bg-background min-h-screen">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD structured data we generate, not user content
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />

      {/* 42rem ≈ 78 characters per line — the same measure the use-case
          articles pin to, so the two long-form templates read identically. */}
      <article className="mx-auto max-w-[42rem] px-6 pt-28 pb-24 sm:pt-32 sm:pb-32">
        <header className="mt-8">
          {topic && (
            <span className="text-muted-foreground/70 font-mono text-xs tracking-wider uppercase">
              {topic}
            </span>
          )}
          <h1 className="text-foreground mt-4 text-3xl font-medium tracking-tight text-balance sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
            {entry.title}
          </h1>
          {entry.description && (
            <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
              {entry.description}
            </p>
          )}
          {/* The rule turns the byline into the boundary between the deck and
              the article, so the lead media does not need its own separator. */}
          <PostByline
            author={author}
            date={entry.date}
            readingTime={entry.readingTime}
            className="border-border/60 mt-8 border-t pt-8"
          />
        </header>

        {entry.leadMedia ? (
          <PostLeadMedia
            media={entry.leadMedia}
            className="border-border/60 mt-10 w-full rounded-md border"
          />
        ) : (
          <BlogCover
            logos={entry.coverLogos ?? []}
            withKortix={entry.coverKortix ?? true}
            className="border-border/60 mt-10 aspect-[16/9] w-full rounded-md border"
          />
        )}

        <BlogContent blocks={entry.blocks} />

        {more.length > 0 && (
          <div className="border-border/60 mt-16 border-t pt-14">
            <h2 className="text-muted-foreground mb-10 font-mono text-xs tracking-wider uppercase">
              More from the blog
            </h2>
            <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2">
              {more.map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </div>
          </div>
        )}
      </article>
    </main>
  );
}
