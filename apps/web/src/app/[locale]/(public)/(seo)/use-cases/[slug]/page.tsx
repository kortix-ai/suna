import Link from '@/components/site-link';
import { getTranslations } from '@/i18n/get-translations';
import { metaDescription } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { BlogProse } from '@/components/blog/blog-prose';
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
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { formatPostDate, resolveAuthor } from '@/lib/blog';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { cn } from '@kortix/ui';
import { siteMetadata } from '@kortix/ui/internal/lib/site-metadata';
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

  const description = metaDescription(data.description);

  return {
    title: data.title,
    description,
    keywords: data.tags?.length ? data.tags : undefined,
    authors: [{ name: author.name }],
    openGraph: {
      type: 'article',
      title: data.title,
      description,
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
      description,
      images: [ogImage],
    },
    alternates: {
      canonical: url,
    },
  };
}

export default async function UseCasePage(props: PageProps) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  if (process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false') notFound();
  const { slug } = await props.params;
  const page = useCasesSource.getPage([slug]);
  if (!page) notFound();

  const data = page.data as any;
  if (data.draft && process.env.NODE_ENV === 'production') notFound();

  const MDX = data.body;
  const author = resolveAuthor(data.author);
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

  const meta: { label: string; value: ReactNode }[] = [
    { label: 'Written by', value: author.name },
    {
      label: 'Published',
      value: <time dateTime={data.date}>{formatPostDate(data.date)}</time>,
    },
    { label: 'Reading time', value: tI18nComplete('text7def269b78b1', { value0: readingTime }) },
    ...(data.tags?.length ? [{ label: 'Topics', value: (data.tags as string[]).join(', ') }] : []),
  ];

  return (
    <main className="bg-background relative min-h-screen pt-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />

      {/* Buio's blog post: title and description, the cover, then the shared
          4-column grid. Column 1 is the sticky byline, columns 2–3 the prose
          (~600px, a calm measure), column 4 the sticky contents and the call to
          action. The hero's measure. */}
      <div className={cn(MARKETING_CONTAINER, 'pb-24 md:pb-30')}>
        <header className="max-w-4xl pt-24 md:pt-30">
          <h1 className="text-foreground text-3xl font-medium tracking-tight text-balance md:text-4xl lg:text-5xl">
            {data.title}
          </h1>
          {data.description ? (
            <p className="text-muted-foreground mt-6 max-w-2xl text-base text-pretty">
              {data.description}
            </p>
          ) : null}
        </header>

        {post ? <UseCaseCover post={post} className="mt-16 aspect-[2/1] w-full" /> : null}

        <div className="mt-16 grid grid-cols-1 gap-y-12 lg:grid-cols-4">
          <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4 lg:sticky lg:top-24 lg:flex lg:flex-col lg:self-start lg:pr-8">
            {meta.map((item) => (
              <div key={item.label}>
                <dt className="text-muted-foreground text-sm">{item.label}</dt>
                <dd className="text-foreground mt-1 text-sm text-pretty">{item.value}</dd>
              </div>
            ))}
          </dl>

          <BlogProse className="min-w-0 lg:col-span-2 lg:pr-8 [&>*:first-child]:mt-0">
            <MDX components={mdxComponents} />
          </BlogProse>

          <aside className="flex flex-col gap-12 lg:sticky lg:top-24 lg:self-start">
            <div className="hidden lg:block">
              <UseCaseToc items={toc} />
            </div>

            <div className="border-border border-t pt-6">
              {templatesEnabled && data.template ? (
                <>
                  <h2 className="text-foreground text-base font-medium">
                    {tI18nComplete.raw('text5bad1b115369')}
                  </h2>
                  <p className="text-muted-foreground mt-2 text-sm text-pretty">
                    {tI18nComplete.raw('text512241b9824c')}
                  </p>
                  <UseTemplateButton templateId={data.template} className="mt-6" size="sm" />
                </>
              ) : (
                <>
                  <h2 className="text-foreground text-base font-medium">
                    {tI18nComplete.raw('text8887e9d916d6')}
                  </h2>
                  <p className="text-muted-foreground mt-2 text-sm text-pretty">
                    {tI18nComplete.raw('text31c48dd4f15a')}
                  </p>
                  <MarketingButton size="md" asChild className="hit-area-y-1 mt-6">
                    <Link href="/auth">{tI18nComplete.raw('text61e8d44ad423')}</Link>
                  </MarketingButton>
                </>
              )}
            </div>
          </aside>
        </div>

        {more.length > 0 ? (
          <section className="border-border mt-24 grid grid-cols-1 gap-y-12 border-t pt-8 lg:grid-cols-4">
            <h2 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:pr-8 lg:text-3xl">
              {tI18nComplete.raw('text564e4ace86b3')}.
            </h2>
            <ul className="grid grid-cols-1 gap-y-12 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-3">
              {more.map((item) => (
                <li key={item.slug} className="sm:pr-6 lg:pr-8">
                  <UseCaseCard post={item} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}
