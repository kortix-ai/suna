import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/pricing');

export default function PricingLayout({ children }: { children: ReactNode }) {
  return children;
}
