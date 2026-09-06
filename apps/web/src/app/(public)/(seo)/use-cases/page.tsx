import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { UseCasesBrowser } from '@/components/use-cases/use-cases-browser';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { siteMetadata } from '@/lib/site-metadata';
import { getAllUseCases } from '@/lib/use-cases';

const TITLE = 'Use Cases';
const HEADLINE = 'The loops that run a company';
const DESCRIPTION =
  'How teams put a workforce of AI agents to work — the loops they engineer, the deliverables they ship, and the reviewed changes that make the company better every day.';
const URL = `${siteMetadata.url}/use-cases`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'Kortix use cases',
    'AI agent case studies',
    'AI command center',
    'AI workforce',
    'loop engineering',
    'agent automation',
  ],
  openGraph: {
    type: 'website',
    title: `Kortix ${TITLE}`,
    description: DESCRIPTION,
    url: URL,
    siteName: 'Kortix',
    images: [{ url: `${siteMetadata.url}/banner.png` }],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Kortix ${TITLE}`,
    description: DESCRIPTION,
    images: [`${siteMetadata.url}/banner.png`],
  },
  alternates: {
    canonical: URL,
  },
};

export default function UseCasesIndexPage() {
  if (process.env.NEXT_PUBLIC_USE_CASES_ENABLED === 'false') notFound();
  const useCases = getAllUseCases();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'Kortix Use Cases',
    description: DESCRIPTION,
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
      <div className="mx-auto max-w-7xl px-6 pb-24 sm:pb-32">
        {/* Measure is capped at max-w-2xl so the deck reads as a paragraph, not
            as a banner stretched across the full 80rem catalog width. */}
        <header className="max-w-2xl pt-32 pb-12 sm:pt-44 sm:pb-16">
          <span className="text-muted-foreground/70 font-mono text-xs tracking-wider uppercase">
            {TITLE}
          </span>
          <h1 className="text-foreground mt-4 text-3xl font-medium tracking-tight text-balance sm:text-4xl md:text-[2.75rem] md:leading-[1.1]">
            {HEADLINE}
          </h1>
          <p className="text-muted-foreground mt-5 text-base leading-relaxed sm:text-lg">
            {DESCRIPTION}
          </p>
        </header>

        <UseCasesBrowser posts={useCases} />
      </div>
    </main>
  );
}
