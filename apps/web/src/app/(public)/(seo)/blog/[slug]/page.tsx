import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BlogContent, PostTags } from '@/components/blog/blog-content';
import { BlogCover } from '@/components/blog/blog-cover';
import { PostByline } from '@/components/blog/post-byline';
import { PostCard } from '@/components/blog/post-card';
import { getAllPosts, getPostEntry, resolveAuthor } from '@/lib/blog';
import { siteMetadata } from '@/lib/site-metadata';

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
          logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.png` },
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <article className="mx-auto max-w-3xl px-6 pt-24 pb-24 sm:pt-32 sm:pb-32">
        <Link
          href="/blog"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          Blog
        </Link>

        <header className="mt-8">
          <PostTags tags={entry.tags} />
          <h1 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
            {entry.title}
          </h1>
          {entry.description && (
            <p className="text-muted-foreground mt-4 text-lg leading-relaxed">
              {entry.description}
            </p>
          )}
          <PostByline
            author={author}
            date={entry.date}
            readingTime={entry.readingTime}
            className="mt-8"
          />
        </header>

        <BlogCover
          logos={entry.coverLogos ?? []}
          withKortix={entry.coverKortix ?? true}
          className="border-border/60 mt-10 aspect-[16/9] w-full rounded-2xl border"
        />

        <BlogContent blocks={entry.blocks} />

        {more.length > 0 && (
          <div className="border-border/60 mt-20 border-t pt-14">
            <h2 className="text-muted-foreground mb-8 text-sm font-medium tracking-[0.15em] uppercase">
              More from the blog
            </h2>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
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
