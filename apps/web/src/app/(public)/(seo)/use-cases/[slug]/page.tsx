import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BlogProse } from '@/components/blog/blog-prose';
import { PostByline } from '@/components/blog/post-byline';
import { Badge } from '@/components/ui/badge';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import {
  Callout,
  Fact,
  Figure,
  KeyFacts,
  PullQuote,
  Stat,
  StatGrid,
  Step,
  Steps,
} from '@/components/use-cases/mdx';
import { UseCaseCard } from '@/components/use-cases/use-case-card';
import { UseCasesCta } from '@/components/use-cases/use-cases-cta';
import { resolveAuthor } from '@/lib/blog';
import { getAllUseCases } from '@/lib/use-cases';
import { useCasesSource } from '@/lib/use-cases-source';
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
  // Case-study kit — authors compose these directly in the .mdx body.
  KeyFacts,
  Fact,
  Callout,
  Steps,
  Step,
  Figure,
  StatGrid,
  Stat,
  PullQuote,
};

interface PageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getAllUseCases().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const page = useCasesSource.getPage([slug]);
  if (!page) return {};

  const data = page.data as any;
  const url = `${siteMetadata.url}/use-cases/${slug}`;
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
    },
  };
}

export default async function UseCasePage(props: PageProps) {
  const { slug } = await props.params;
  const page = useCasesSource.getPage([slug]);
  if (!page) notFound();

  const data = page.data as any;
  if (data.draft && process.env.NODE_ENV === 'production') notFound();

  const MDX = data.body;
  const author = resolveAuthor(data.author);
  const archetype = data.tags?.[0] as string | undefined;
  const readingTime = getAllUseCases().find((p) => p.slug === slug)?.readingTime ?? 1;
  const more = getAllUseCases()
    .filter((p) => p.slug !== slug)
    .slice(0, 2);

  const postUrl = `${siteMetadata.url}/use-cases/${slug}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
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
          {
            '@type': 'ListItem',
            position: 1,
            name: 'Use Cases',
            item: `${siteMetadata.url}/use-cases`,
          },
          { '@type': 'ListItem', position: 2, name: data.title, item: postUrl },
        ],
      },
    ],
  };

  return (
    <main className="bg-background relative min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Branded hero header — faint letter-field backdrop ties it to the platform. */}
      <section className="relative overflow-hidden px-6 pt-28 pb-4 sm:pt-32">
        <div className="absolute inset-0 z-0 mask-y-to-90% opacity-60">
          <KortixLetterField seed={5190} />
        </div>
        <div className="relative z-10 mx-auto max-w-3xl">
          <Link
            href="/use-cases"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Use Cases
          </Link>

          <header className="mt-8">
            {archetype && (
              <div className="text-muted-foreground mb-4 flex items-center gap-2 font-mono text-xs tracking-wider uppercase">
                <KortixAsterisk index={0} parentClass="size-4" />
                {archetype}
              </div>
            )}
            <h1 className="text-foreground text-3xl font-medium tracking-tight sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
              {data.title}
            </h1>
            {data.description && (
              <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
                {data.description}
              </p>
            )}
            {data.tags?.length > 1 && (
              <div className="mt-6 flex flex-wrap gap-1.5">
                {data.tags.slice(1).map((tag: string) => (
                  <Badge key={tag} size="sm" variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
            <PostByline
              author={author}
              date={data.date}
              readingTime={readingTime}
              className="mt-8"
            />
          </header>
        </div>
      </section>

      <article className="mx-auto max-w-3xl px-6 pb-20 sm:pb-24">
        {data.cover && (
          <div className="border-border bg-muted relative mt-6 aspect-[16/9] overflow-hidden rounded-sm border">
            <Image
              src={data.cover}
              alt={data.title}
              fill
              priority
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 768px"
            />
          </div>
        )}

        <BlogProse className="mt-10">
          <MDX components={mdxComponents} />
        </BlogProse>
      </article>

      {more.length > 0 && (
        <section className="border-border/60 border-t">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
            <h2 className="text-muted-foreground mb-8 font-mono text-xs font-medium tracking-[0.15em] uppercase">
              More use cases
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {more.map((post) => (
                <UseCaseCard key={post.slug} post={post} />
              ))}
            </div>
          </div>
        </section>
      )}

      <UseCasesCta />
      <div className="h-16 sm:h-24" />
    </main>
  );
}
