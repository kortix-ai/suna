import type { Metadata } from 'next';

import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/features/layout/section/empty-state';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { UseCaseCard } from '@/components/use-cases/use-case-card';
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
  const useCases = getAllUseCases();
  const [featured, ...rest] = useCases;

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
      <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:pt-36">
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

      <section className="mx-auto max-w-6xl px-6 py-10 sm:py-14 lg:px-0">
        {useCases.length === 0 ? (
          <EmptyState
            title="No use cases yet"
            description="Case studies and use cases are on the way. Check back soon."
          />
        ) : (
          <div className="flex flex-col gap-4">
            <Reveal>
              <UseCaseCard post={featured} featured />
            </Reveal>

            {rest.length > 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {rest.map((post, i) => (
                  <Reveal key={post.slug} delay={Math.min(i * 0.05, 0.2)}>
                    <UseCaseCard post={post} />
                  </Reveal>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <UseCasesCta />
      <div className="h-16 sm:h-24" />
    </main>
  );
}
