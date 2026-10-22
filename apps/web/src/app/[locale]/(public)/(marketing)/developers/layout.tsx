import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/developers');
}

export default function DevelopersLayout({ children }: { children: ReactNode }) {
  return children;
}
