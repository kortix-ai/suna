import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import { requireServicesPages } from '@/lib/services-pages-gate';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/case-studies');
}

export default async function CaseStudiesLayout({ children }: { children: ReactNode }) {
  await requireServicesPages();
  return children;
}
