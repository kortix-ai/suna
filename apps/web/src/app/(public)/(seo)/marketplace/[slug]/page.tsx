import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { PublicSubprojectDetail } from '@/features/subprojects/public-subproject-detail';
import { loadPublicSubproject } from '@/features/subprojects/public-subprojects-server';
import type { Subproject } from '@/features/subprojects/subprojects-catalog';
import { safeJsonForHtml } from '@/lib/security/safe-json';
import { socialMetadata } from '@/lib/seo/metadata';
import { CANONICAL_ORIGIN, siteMetadata } from '@/lib/site-metadata';

interface PageProps {
  params: Promise<{ slug: string }>;
}

/**
 * `/marketplace/<slug>` — one public subproject, for search.
 *
 * The page exists because `/marketplace` alone gives a crawler one URL for the
 * whole catalogue. A per-subproject URL is what can rank for "<the loop this
 * runs> AI agent", and it is the landing page the index's cards link to.
 *
 * No `generateStaticParams`. The catalogue lives in the API, which is not
 * reachable during `next build` in CI, so pre-rendering the list would either
 * fail the build or bake an empty set. On-demand ISR gives the same result one
 * request later: the first hit renders and caches, the next hour is served from
 * the cache.
 */
export const revalidate = 3600;

/** The description a crawler and a social card get when the manifest has none. */
function describe(subproject: Subproject): string {
  return (
    subproject.description ??
    `Install ${subproject.title} into your Kortix project — agents, skills, connectors and triggers, as files you own and review.`
  );
}

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { slug } = await props.params;
  const subproject = await loadPublicSubproject(slug);
  // Empty metadata, not a 404 title. The page itself calls `notFound()`, and
  // Next renders `not-found.tsx`'s own metadata over this.
  if (!subproject) return {};

  const url = `${CANONICAL_ORIGIN}/marketplace/${slug}`;
  const description = describe(subproject);
  return {
    title: subproject.title,
    description,
    alternates: { canonical: url },
    ...socialMetadata(`${subproject.title} — Kortix Marketplace`, description, url),
  };
}

export default async function PublicSubprojectPage(props: PageProps) {
  const { slug } = await props.params;
  const subproject = await loadPublicSubproject(slug);
  // Null covers both a slug that does not exist and one that is account-scoped or
  // private: the API answers 404 for all three, so this page can never confirm
  // that a non-public subproject exists.
  if (!subproject) notFound();

  const url = `${CANONICAL_ORIGIN}/marketplace/${slug}`;
  const description = describe(subproject);
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: subproject.title,
      description,
      url,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      publisher: {
        '@type': 'Organization',
        name: siteMetadata.name,
        logo: { '@type': 'ImageObject', url: `${CANONICAL_ORIGIN}/favicon.svg` },
      },
      // The install is free; what it consumes afterwards is metered on the
      // account. `price: 0` states the former only, which is what the button says.
      offers: { '@type': 'Offer', price: 0, priceCurrency: 'USD' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Marketplace',
          item: `${CANONICAL_ORIGIN}/marketplace`,
        },
        { '@type': 'ListItem', position: 2, name: subproject.title, item: url },
      ],
    },
  ];

  return (
    <main className="bg-background relative min-h-screen">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonForHtml(jsonLd) }}
      />
      <PublicSubprojectDetail subproject={subproject} />
    </main>
  );
}
