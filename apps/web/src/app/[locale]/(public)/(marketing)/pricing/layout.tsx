import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/pricing');
}

export default function PricingLayout({ children }: { children: ReactNode }) {
  return children;
}
