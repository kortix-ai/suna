import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { localizedMarketingMetadata } from '@/lib/seo/metadata';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/support');
}

export default function SupportLayout({ children }: { children: ReactNode }) {
  return children;
}
