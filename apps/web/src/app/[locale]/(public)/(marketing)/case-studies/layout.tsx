import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/case-studies');
}

export default function CaseStudiesLayout({ children }: { children: ReactNode }) {
  return children;
}
