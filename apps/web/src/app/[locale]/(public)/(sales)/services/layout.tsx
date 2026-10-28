import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import { requireServicesPages } from '@/lib/services-pages-gate';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/services');
}

export default async function ServicesLayout({ children }: { children: ReactNode }) {
  await requireServicesPages();
  return children;
}
