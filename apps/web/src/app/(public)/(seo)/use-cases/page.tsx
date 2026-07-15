import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { UseCasesBrowser } from '@/components/use-cases/use-cases-browser';
import { UseCasesCta } from '@/components/use-cases/use-cases-cta';
import { getAllUseCases } from '@/lib/use-cases';
import { siteMetadata } from '@/lib/site-metadata';

const TITLE = 'Use Cases';
const EYEBROW = 'Loop Engineering';
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
      logo: { '@type': 'ImageObject', url: `${siteMetadata.url}/favicon.png` },
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero — animated letter field backdrop, like the marketing pages. */}
      <section className="relative overflow-hidden px-5 pt-32 pb-12 sm:pt-36">
        <div className="absolute inset-0 z-0 mask-y-to-95%">
          <KortixLetterField seed={7412} />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl">
          <Reveal>
            <Badge variant="kortix" className="rounded">
              {EYEBROW}
            </Badge>
            <h1 className="text-foreground mt-5 max-w-4xl text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
              {HEADLINE}
            </h1>
            <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
              {DESCRIPTION}
            </p>
          </Reveal>
        </div>
      </section>

      <section className="px-5 py-10 sm:py-14">
        <div className="mx-auto max-w-6xl">
          <UseCasesBrowser posts={useCases} />
        </div>
      </section>

      <UseCasesCta />
      <div className="h-16 sm:h-24" />
    </main>
  );
}
