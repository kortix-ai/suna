import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/white-label');
}

export default function WhiteLabelLayout({ children }: { children: ReactNode }) {
  return children;
}
