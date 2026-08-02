import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { localizedMarketingMetadata } from '@/lib/seo/metadata';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/legal');
}

export default function LegalLayout({ children }: { children: ReactNode }) {
  return children;
}
