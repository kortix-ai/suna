import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { UseCasesBrowser } from '@/components/use-cases/use-cases-browser';
import { MARKETING_CONTAINER } from '@/features/marketing/kit/section';
import { getTranslations } from '@/i18n/get-translations';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { cn } from '@/lib/utils';
import { siteMetadata } from '@/lib/site-metadata';
import { getAllUseCases } from '@/lib/use-cases';

const URL = `${siteMetadata.url}/use-cases`;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('hardcodedUi.i18nComplete');
  const title = t.raw('textb697dd6a71d9');
  const description = t.raw('text7fa8aef486d8');
  return {
    title,
    description,
    keywords: [
      'Kortix use cases',
      'AI agent case studies',
      'AI Operating System',
      'AI workforce',
      'loop engineering',
      'agent automation',
    ],
    openGraph: {
      type: 'website',
      title: `Kortix ${title}`,
      description,
      url: URL,
      siteName: 'Kortix',
      images: [{ url: `${siteMetadata.url}/banner.png` }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `Kortix ${title}`,
      description,
      images: [`${siteMetadata.url}/banner.png`],
    },
    alternates: {
      canonical: URL,
    },
  };
}

export default async function UseCasesIndexPage() {
  if (process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false') notFound();
  const t = await getTranslations('hardcodedUi.i18nComplete');
  const description = t.raw('text7fa8aef486d8');
  const useCases = getAllUseCases();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: t.raw('text5f513e5b2937'),
    description,
    url: URL,
    publisher: {
      '@type': 'Organization',
      name: 'Kortix',
      logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.svg` },
    },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: useCases.map((post, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: post.data.title,
        url: `${siteMetadata.url}${post.url}`,
      })),
    },
  };

  return (
    <main className="bg-background relative min-h-screen pt-16">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />
      {/* The /blog layout: two-tone title, filter row, lead, then the grid. */}
      <div className={cn(MARKETING_CONTAINER, 'pt-24 pb-24 md:pt-30 md:pb-30')}>
        <UseCasesBrowser
          posts={useCases}
          title={
            <h1 className="text-foreground text-xl font-medium tracking-tight text-balance md:text-2xl lg:text-3xl">
              Use cases{' '}
              <span className="text-muted-foreground block">Real work Kortix agents run, end to end.</span>
            </h1>
          }
        />
      </div>
    </main>
  );
}
