import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { BlogProse } from '@/components/blog/blog-prose';
import { PostByline } from '@/components/blog/post-byline';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { UserAvatar } from '@/components/ui/user-avatar';
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
import { UseCaseToc, type TocItem } from '@/components/use-cases/use-case-toc';
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
  if (process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false') notFound();
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
    .slice(0, 3);
  const toc = (data.toc ?? []) as TocItem[];
  const post = getAllUseCases().find((p) => p.slug === slug);
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
      <section className="relative overflow-hidden px-5 pt-28 pb-4 sm:pt-32">
        <div className="absolute inset-0 z-0 mask-y-to-90% opacity-60">
          <KortixLetterField seed={5190} />
        </div>
        <div className="relative z-10 mx-auto grid max-w-6xl gap-x-12 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0">
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
            {templatesEnabled && data.template && (
              <div className="mt-8">
                <UseTemplateButton templateId={data.template} />
              </div>
            )}
            </header>
          </div>
        </div>
      </section>

      <div className="px-5 pb-16 sm:pb-20">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0">
            {post && (
            <UseCaseCover
              post={post}
              className="border-border aspect-[16/9] w-full rounded-2xl border"
            />
          )}
          <BlogProse className="mt-10">
            <MDX components={mdxComponents} />
          </BlogProse>
        </div>

        <aside className="hidden lg:block">
          <div className="sticky top-24 space-y-8">
            <div className="flex items-center gap-3">
              <UserAvatar
                email={author.email}
                name={author.name}
                avatarUrl={author.avatarUrl}
                size="lg"
              />
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">{author.name}</p>
                {author.role && (
                  <p className="text-muted-foreground truncate text-xs">{author.role}</p>
                )}
              </div>
            </div>

            <UseCaseToc items={toc} />

            <div className="border-border rounded-2xl border p-5">
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
        <section className="border-border/60 border-t px-5">
          <div className="mx-auto max-w-6xl py-16 sm:py-20">
            <h2 className="text-foreground mb-8 text-2xl font-medium tracking-tight">Read more</h2>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {more.map((item) => (
                <UseCaseCard key={item.slug} post={item} />
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
