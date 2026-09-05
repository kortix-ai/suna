import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui/marketing/button';
import { PublicTemplatesGrid } from '@/features/marketplace/public-templates-grid';
import { loadPublicTemplates } from '@/features/marketplace/public-templates-server';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { socialMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN, siteMetadata } from '@/lib/site-metadata';

const TITLE = 'Marketplace';
const HEADLINE = 'Install a working loop, not a blank project';
const DESCRIPTION =
  'Browse the Kortix template marketplace. Each template carries the agents, skills, connectors and triggers that run one loop end to end — installed into your own repo as files you own and review.';
const URL = `${CANONICAL_ORIGIN}/marketplace`;

/**
 * `/marketplace` — the PUBLIC template catalog, and an SEO acquisition
 * channel. It is the sibling of `/projects/[id]/customize/marketplace` with
 * two deliberate differences:
 *
 *  - No auth. The rows come from `GET /v1/public/marketplace/templates`, a
 *    static curated list that is the same for every caller.
 *  - No install button on the grid. Installing needs a project, a visitor here
 *    has none, and the page must not imply one. Every card links to its detail
 *    page; the detail page carries the sign-up CTA.
 *
 * `revalidate = 3600` matches the API's own `Cache-Control: public, max-age=300`
 * loosely on purpose: the catalog changes when a deploy ships, so an hour-old
 * page is never wrong enough to matter.
 */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'Kortix marketplace',
    'AI agent templates',
    'ready-made AI agents',
    'AI automation templates',
    'open source AI agents',
  ],
  alternates: { canonical: URL },
  ...socialMetadata(`Kortix ${TITLE}`, DESCRIPTION, URL),
};

export default async function MarketplacePage() {
  const templates = await loadPublicTemplates();

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
      numberOfItems: templates.length,
      itemListElement: templates.map((template, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: template.title,
        url: `${URL}/${template.slug}`,
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
            banner stretched across the full 80rem catalog width — the same
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

        <PublicTemplatesGrid templates={templates} />
      </div>
    </main>
  );
}
