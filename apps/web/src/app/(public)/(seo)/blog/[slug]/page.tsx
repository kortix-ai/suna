import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BlogProse } from '@/components/blog/blog-prose';
import { PostByline } from '@/components/blog/post-byline';
import { PostCard } from '@/components/blog/post-card';
import { Badge } from '@/components/ui/badge';
import { getAllPosts, resolveAuthor } from '@/lib/blog';
import { blogSource } from '@/lib/blog-source';
import { siteMetadata } from '@/lib/site-metadata';

// Render plain HTML elements so BlogProse owns all typography — no docs chrome.
// Internal links route client-side; external links open safely in a new tab.
const mdxComponents = {
  a: ({ href = '', children, ...rest }: any) =>
    href.startsWith('/') ? (
      <Link href={href} {...rest}>
        {children}
      </Link>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
        {children}
      </a>
    ),
  img: (props: any) => <img loading="lazy" {...props} />,
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getAllPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) return {};

  const data = page.data as any;
  const url = `${siteMetadata.url}/blog/${slug}`;
  const ogImage = data.cover
    ? `${siteMetadata.url}${data.cover}`
    : `${siteMetadata.url}/banner.png`;
  const author = resolveAuthor(data.author);

  return {
    title: data.title,
    description: data.description,
    keywords: data.tags?.length ? data.tags : undefined,
    authors: [{ name: author.name }],
    openGraph: {
      type: 'article',
      title: data.title,
      description: data.description,
      url,
      siteName: 'Kortix',
      publishedTime: data.date,
      modifiedTime: data.date,
      authors: [author.name],
      tags: data.tags,
      images: [{ url: ogImage, width: 1200, height: 630, alt: data.title }],
    },
    twitter: {
      card: 'summary_large_image',
      title: data.title,
      description: data.description,
      images: [ogImage],
    },
    alternates: {
      canonical: url,
      types: { 'application/rss+xml': `${siteMetadata.url}/blog/rss.xml` },
    },
  };
}

export default async function BlogPostPage(props: PageProps) {
  const tI18nHardcoded = await getTranslations('hardcodedUi');
  const { slug } = await props.params;
  const page = blogSource.getPage([slug]);
  if (!page) notFound();

  const data = page.data as any;
  if (data.draft && process.env.NODE_ENV === 'production') notFound();

  const MDX = data.body;
  const author = resolveAuthor(data.author);
  const readingTime = getAllPosts().find((p) => p.slug === slug)?.readingTime ?? 1;
  const more = getAllPosts()
    .filter((p) => p.slug !== slug)
    .slice(0, 2);

  const postUrl = `${siteMetadata.url}/blog/${slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        headline: data.title,
        description: data.description,
        datePublished: data.date,
        dateModified: data.date,
        keywords: data.tags,
        timeRequired: `PT${readingTime}M`,
        author: { '@type': 'Person', name: author.name },
        publisher: {
          '@type': 'Organization',
          name: 'Kortix',
          logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.png` },
        },
        image: data.cover ? `${siteMetadata.url}${data.cover}` : `${siteMetadata.url}/banner.png`,
        url: postUrl,
        mainEntityOfPage: postUrl,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Blog', item: `${siteMetadata.url}/blog` },
          { '@type': 'ListItem', position: 2, name: data.title, item: postUrl },
        ],
      },
    ],
  };

  return (
    <main className="bg-background min-h-screen">
      <script
        type="application/ld+json"
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
          {data.tags?.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-1.5">
              {data.tags.map((tag: string) => (
                <Badge key={tag} size="sm" variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
          <h1 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
            {data.title}
          </h1>
          {data.description && (
            <p className="text-muted-foreground mt-4 text-lg leading-relaxed">{data.description}</p>
          )}
          <PostByline author={author} date={data.date} readingTime={readingTime} className="mt-8" />
        </header>

        {data.cover && (
          <div className="border-border/60 bg-muted relative mt-10 aspect-[16/9] overflow-hidden rounded-2xl border">
            <Image
              src={data.cover}
              alt={data.title}
              fill
              priority
              className="object-cover"
              sizes={tI18nHardcoded.raw('autoAppPublicSeoBlogSlugPageJsxAttrSizesMaxbb7ac8fb')}
            />
          </div>
        )}

        <BlogProse className="mt-10">
          <MDX components={mdxComponents} />
        </BlogProse>
      </article>

      {more.length > 0 && (
        <section className="border-border/60 border-t">
          <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
            <h2 className="text-muted-foreground mb-8 text-sm font-medium tracking-[0.15em] uppercase">
              {tI18nHardcoded.raw('autoAppPublicSeoBlogSlugPageJsxTextMoreFrom3f4590f3')}
            </h2>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              {more.map((post) => (
                <PostCard key={post.slug} post={post} />
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
