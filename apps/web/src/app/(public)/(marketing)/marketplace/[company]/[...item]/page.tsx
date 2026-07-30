import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { MarketplaceDetailPublic } from '@/features/marketplace/marketplace-detail-public';
import { PublicMarketplaceProvider } from '@/features/marketplace/marketplace-public-surface';
import {
  getPublicMarketplaceItem,
  listPublicMarketplaceItems,
  listPublicMarketplaces,
} from '@/lib/marketplace-public';
import { pathPartsToItemId } from '@/lib/marketplace-slug';

// The root layout (app/layout.tsx) forces the whole app into per-request dynamic
// rendering via `connection()`/`headers()` (so self-host Docker images read env
// at request time, not build time). ISR config here (`revalidate` +
// `generateStaticParams`) is therefore dead — and worse, it routed uncached
// item URLs through Next's on-demand static-generation path, which collides with
// the layout's dynamic APIs and throws an UNCAUGHT `DYNAMIC_SERVER_USAGE` → a 500
// for EVERY /marketplace/<company>/<item> page (generateStaticParams also returns
// [] whenever the API isn't reachable at build time, e.g. any Docker image build,
// so nothing was pre-rendered anyway). Force dynamic to match reality: SSR each
// request, no static-generation pass to conflict with.
export const dynamic = 'force-dynamic';

interface PageParams {
  company: string;
  item: string[];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<PageParams>;
}): Promise<Metadata> {
  const { company, item } = await params;
  const id = pathPartsToItemId(company, item);
  try {
    const detail = await getPublicMarketplaceItem(id);
    const description = detail.description ?? `${detail.title} on the Kortix Marketplace.`;
    return {
      title: `${detail.title} — Kortix Marketplace`,
      description,
      openGraph: { title: `${detail.title} — Kortix Marketplace`, description },
    };
  } catch {
    return { title: 'Marketplace — Kortix' };
  }
}

export default async function MarketplaceItemPage({ params }: { params: Promise<PageParams> }) {
  const { company, item } = await params;
  const id = pathPartsToItemId(company, item);

  let detail;
  let marketplacesPage;
  try {
    [detail, marketplacesPage] = await Promise.all([
      getPublicMarketplaceItem(id),
      listPublicMarketplaces(),
    ]);
  } catch {
    notFound();
  }

  const companySummary = marketplacesPage.marketplaces.find((m) => m.id === detail.marketplaceId);

  // Cross-link discovery for a whole-project item: server-rendered (not
  // client-fetched) so "Other projects" is part of the same static/ISR page.
  const otherProjects =
    detail.type === 'registry:project'
      ? (await listPublicMarketplaceItems({ type: 'project' })).items.filter((it) => it.id !== id)
      : [];

  return (
    <PublicMarketplaceProvider>
      <MarketplaceDetailPublic data={detail} company={companySummary} otherProjects={otherProjects} />
    </PublicMarketplaceProvider>
  );
}
