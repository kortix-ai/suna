import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { MarketplaceDetail } from '@/features/marketplace/marketplace-detail';
import { PublicMarketplaceProvider } from '@/features/marketplace/marketplace-public-surface';
import {
  getPublicMarketplaceItem,
  listPublicMarketplaceItems,
  listPublicMarketplaces,
} from '@/lib/marketplace-public';
import { itemIdToPathParts, pathPartsToItemId } from '@/lib/marketplace-slug';

export const revalidate = 3600;

interface PageParams {
  company: string;
  item: string[];
}

export async function generateStaticParams() {
  try {
    const { items } = await listPublicMarketplaceItems();
    return items.map((entry) => {
      const { company, item } = itemIdToPathParts(entry.id);
      return { company, item };
    });
  } catch {
    return [];
  }
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
      <MarketplaceDetail data={detail} company={companySummary} otherProjects={otherProjects} />
    </PublicMarketplaceProvider>
  );
}
