import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/services');
}

export default function ServicesLayout({ children }: { children: ReactNode }) {
  return children;
}
