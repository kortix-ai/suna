import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { localizedMarketingMetadata } from '@/lib/seo/metadata';

export function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/');
}

export default function HomeLayout({ children }: { children: ReactNode }) {
  return children;
}
