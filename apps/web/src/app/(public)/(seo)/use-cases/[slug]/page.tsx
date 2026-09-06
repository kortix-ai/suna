import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BlogProse } from '@/components/blog/blog-prose';
import { PostByline } from '@/components/blog/post-byline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { UseTemplateButton } from '@/components/use-cases/template-install-dialog';
import { UseCaseCard, UseCaseCover } from '@/components/use-cases/use-case-card';
import { UseCaseMdxImage } from '@/components/use-cases/use-case-mdx-image';
import { UseCaseToc, type TocItem } from '@/components/use-cases/use-case-toc';
import { resolveAuthor } from '@/lib/blog';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@/lib/site-metadata';
import { getAllUseCases } from '@/lib/use-cases';
import { useCasesSource } from '@/lib/use-cases-source';

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
  img: UseCaseMdxImage,
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
  if (process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false') notFound();
  const { slug } = await props.params;
  const page = useCasesSource.getPage([slug]);
  if (!page) notFound();

  const data = page.data as any;
  if (data.draft && process.env.NODE_ENV === 'production') notFound();

  const MDX = data.body;
  const author = resolveAuthor(data.author);
  const archetype = data.tags?.[0] as string | undefined;
  const allUseCases = getAllUseCases();
  const post = allUseCases.find((p) => p.slug === slug);
  const readingTime = post?.readingTime ?? 1;
  const more = allUseCases.filter((p) => p.slug !== slug).slice(0, 3);
  const toc = (data.toc ?? []) as TocItem[];
  // Default-on kill-switch shared with the API (KORTIX_TEMPLATES_ENABLED) — set it
  // to 'false' to hide the "Use this template" button.
  const templatesEnabled = process.env.KORTIX_TEMPLATES_ENABLED !== 'false';

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
          logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.svg` },
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
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />

      {/* Measure first: the article column is pinned to 42rem (~78 characters)
          at every breakpoint. Below xl it is simply centred on the page; at xl
          the sticky rail appears beside it and the pair is centred together, so
          the prose width never changes when the rail arrives. */}
      <div className="mx-auto max-w-[42rem] px-6 pt-28 pb-20 sm:pt-32 lg:max-w-7xl lg:px-8">
        <div className="lg:grid lg:grid-cols-[minmax(0,64rem)_16rem] lg:justify-center lg:gap-x-16">
          <article className="min-w-0">
            <header>
              {archetype && (
                <span
                  className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
                  data-text="true"
                >
                  {archetype}
                </span>
              )}
              <h1 className="text-foreground mt-4 text-3xl font-medium tracking-tight text-balance sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
                {data.title}
              </h1>
              {data.description && (
                <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
                  {data.description}
                </p>
              )}
              <PostByline
                author={author}
                date={data.date}
                readingTime={readingTime}
                className="border-border/60 mt-8 border-t pt-8"
              />
            </header>

            {post && (
              <UseCaseCover
                post={post}
                className="border-border/60 mt-10 aspect-[16/9] w-full rounded-md border"
              />
            )}

            <BlogProse className="mt-10">
              <MDX components={mdxComponents} />
            </BlogProse>

            {data.tags?.length > 1 && (
              <div className="border-border/60 mt-12 flex flex-wrap gap-1.5 border-t pt-8">
                {data.tags.slice(1).map((tag: string) => (
                  <Badge key={tag} variant="secondary">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </article>

          <aside className="hidden lg:block">
            <div className="sticky top-24 space-y-8">
              <UseCaseToc items={toc} />

              <div className="border-border/60 bg-popover rounded-md border px-4 py-5">
                {templatesEnabled && data.template ? (
                  <>
                    <p className="text-foreground text-sm font-medium">Run this yourself</p>
                    <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                      Install this exact setup — agent, connectors, schedule, and guardrails — in a
                      guided flow.
                    </p>
                    <UseTemplateButton
                      templateId={data.template}
                      className="mt-4 w-full"
                      size="sm"
                    />
                  </>
                ) : (
                  <>
                    <p className="text-foreground text-sm font-medium">Build your own</p>
                    <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                      Put a workforce of AI agents to work on your own systems — connected, guarded,
                      and reviewed.
                    </p>
                    <Button asChild size="sm" className="mt-4 w-full">
                      <Link href="/">Get started</Link>
                    </Button>
                  </>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>

      {more.length > 0 && (
        <section className="border-border border-t">
          <div className="mx-auto max-w-7xl px-6 py-16 sm:py-20">
            <h2 className="text-muted-foreground mb-10 font-mono text-xs tracking-wider uppercase">
              More use cases
            </h2>
            <div className="grid grid-cols-1 gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
              {more.map((item) => (
                <UseCaseCard key={item.slug} post={item} />
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
