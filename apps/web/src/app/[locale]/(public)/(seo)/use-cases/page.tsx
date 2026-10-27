import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { UseCasesBrowser } from '@/components/use-cases/use-cases-browser';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { getTranslations } from '@/i18n/get-translations';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { getAllUseCases } from '@/lib/use-cases';
import { siteMetadata } from '@kortix/ui/internal/lib/site-metadata';

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
    <PageFrame>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />
      <PageHero
        title="Use cases."
        titleMuted="Outcomes agents deliver, for every team."
        sub={`${useCases.length} jobs Kortix agents run end to end, each on its own cloud computer, with the tools your team already uses and a person approving what matters.`}
        actions={
          <>
            <MarketingButton size="md" className="hit-area-y-1" asChild>
              <Link href="/auth">Start for free</Link>
            </MarketingButton>
            <MarketingButton size="md" variant="secondary" className="hit-area-y-1" asChild>
              <Link href="/case-studies">See case studies</Link>
            </MarketingButton>
          </>
        }
      />
      <div className="border-t px-6 py-16 lg:px-28 lg:py-20">
        <UseCasesBrowser posts={useCases} />
      </div>
      <div className="flex flex-col items-start gap-5 border-t px-8 py-16 sm:flex-row sm:items-center sm:justify-between lg:px-28">
        <p className="text-foreground text-lg font-medium text-balance">
          Don&apos;t see yours?{' '}
          <span className="text-muted-foreground">
            Describe it to an agent, or have our team build it.
          </span>
        </p>
        <div className="flex flex-wrap gap-2.5">
          <MarketingButton size="md" asChild>
            <Link href="/auth">Start for free</Link>
          </MarketingButton>
          <MarketingButton size="md" variant="secondary" asChild>
            <Link href="/services">AI Transformation</Link>
          </MarketingButton>
        </div>
      </div>
    </PageFrame>
  );
}
