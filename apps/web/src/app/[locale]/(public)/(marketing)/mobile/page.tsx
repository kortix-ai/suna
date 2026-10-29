import { SurfacePage } from '@/features/marketing/surfaces/surface-page';
import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/mobile');
}

/** `/mobile`: copy in features/marketing/surfaces/content.ts, layout in surface-page.tsx. */
export default function Page(): ReactNode {
  return <SurfacePage id="mobile" />;
}
