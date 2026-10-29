import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/framework');
}

export default function FrameworkLayout({ children }: { children: ReactNode }) {
  return children;
}
