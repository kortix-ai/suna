import type { Metadata } from 'next';

import { PublicTemplatesExplore } from '@/features/templates/public-templates-explore';
import { loadPublicTemplates } from '@/features/templates/public-templates-server';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { socialMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN, siteMetadata } from '@/lib/site-metadata';

const TITLE = 'Templates';
const HEADLINE = 'Install a working loop, not a blank project';
const DESCRIPTION =
  'Browse the Kortix template catalog. Each template carries the agents, skills, connectors and triggers that run one loop end to end — installed into your own repo as files you own and review.';
const URL = `${CANONICAL_ORIGIN}/templates`;

/**
 * `/templates` — the PUBLIC template catalog, and an SEO acquisition
 * channel. It is the sibling of `/projects/[id]/customize/templates` with
 * two deliberate differences:
 *
 *  - No auth. The rows come from `GET /v1/public/templates`, a
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
    'Kortix templates',
    'AI agent templates',
    'ready-made AI agents',
    'AI automation templates',
    'open source AI agents',
  ],
  alternates: { canonical: URL },
  ...socialMetadata(`Kortix ${TITLE}`, DESCRIPTION, URL),
};

export default async function TemplatesPage() {
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
      {/* The explore surface owns the page container: it is a pinned rail beside
          the catalog, so the headline and the description belong in that rail
          rather than in a banner above it. They are passed down from the same
          constants the metadata above uses, so the two can never drift. */}
      <PublicTemplatesExplore
        templates={templates}
        headline={HEADLINE}
        description={DESCRIPTION}
      />
    </main>
  );
}
