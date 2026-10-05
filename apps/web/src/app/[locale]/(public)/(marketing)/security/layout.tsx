import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/security');
}

export default function SecurityLayout({ children }: { children: ReactNode }) {
  return children;
}
