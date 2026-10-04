import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { UseCasesBrowser } from '@/components/use-cases/use-cases-browser';
import { PageHero } from '@/features/marketing/component/page-hero';
import { getTranslations } from '@/i18n/get-translations';
import { safeJsonForHtml } from '@/lib/security/safe-json';
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
  const tUseCases = await getTranslations('useCases');
  const title = t.raw('textb697dd6a71d9');
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
    <main className="bg-background relative min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />
      <PageHero size="band" eyebrow={title} title={tUseCases('headline')} sub={description} />
      <div className="mx-auto max-w-7xl px-6 pt-12 pb-24 sm:pb-32">
        <UseCasesBrowser posts={useCases} />
      </div>
    </main>
  );
}
