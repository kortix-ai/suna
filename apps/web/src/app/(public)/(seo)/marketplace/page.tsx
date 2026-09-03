import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/marketing/button';
import { PublicSubprojectsGrid } from '@/features/subprojects/public-subprojects-grid';
import { loadPublicSubprojects } from '@/features/subprojects/public-subprojects-server';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { socialMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN, siteMetadata } from '@/lib/site-metadata';

const TITLE = 'Marketplace';
const HEADLINE = 'Install a working loop, not a template';
const DESCRIPTION =
  'Browse the public Kortix subproject catalogue. Each one carries the agents, skills, connectors and triggers that run one loop end to end — installed into your own repo as files you own and review.';
const URL = `${CANONICAL_ORIGIN}/marketplace`;

/**
 * `/marketplace` — the PUBLIC subproject catalogue, and an SEO acquisition
 * channel. It is the sibling of `/projects/[id]/marketplace` with two
 * deliberate differences:
 *
 *  - No auth. The rows come from `GET /v1/public/subprojects`, which is narrowed
 *    to `visibility = 'public' AND status = 'active'` in the store's WHERE
 *    clause. An account-scoped or private subproject can never reach this page.
 *  - No installed state. Installing needs a project, a visitor here has none,
 *    and the page must not imply one. Every card links to its detail page; the
 *    detail page carries the sign-up CTA.
 *
 * `revalidate = 3600` matches the API's own `Cache-Control: public, max-age=300`
 * loosely on purpose: the catalogue is curated by migration, so it changes on the
 * order of weeks, and an hour-old page is never wrong enough to matter.
 */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'Kortix marketplace',
    'AI agent templates',
    'agent subprojects',
    'ready-made AI agents',
    'AI automation templates',
    'open source AI agents',
  ],
  alternates: { canonical: URL },
  ...socialMetadata(`Kortix ${TITLE}`, DESCRIPTION, URL),
};

export default async function MarketplacePage() {
  const subprojects = await loadPublicSubprojects();

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `Kortix ${TITLE}`,
    description: DESCRIPTION,
    url: URL,
    publisher: {
      '@type': 'Organization',
      name: siteMetadata.name,
      logo: { '@type': 'ImageObject', url: `${CANONICAL_ORIGIN}/favicon.svg` },
    },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: subprojects.length,
      itemListElement: subprojects.map((subproject, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: subproject.title,
        url: `${URL}/${subproject.slug}`,
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
        {/* Measure capped at max-w-2xl so the deck reads as a paragraph, not as a
            banner stretched across the full 80rem catalogue width — the same
            header shape `/use-cases` uses. */}
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
          <Button asChild size="lg" className="mt-8">
            <Link href="/auth">Start free to install</Link>
          </Button>
        </header>

        <PublicSubprojectsGrid subprojects={subprojects} />
      </div>
    </main>
  );
}
