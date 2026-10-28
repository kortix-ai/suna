import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/sovereign');
}

export default function SovereignLayout({ children }: { children: ReactNode }) {
  return children;
}
