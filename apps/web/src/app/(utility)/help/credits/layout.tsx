import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { marketingMetadata } from '@/lib/seo/metadata';

export const metadata: Metadata = marketingMetadata('/help/credits');

export default function HelpCreditsLayout({ children }: { children: ReactNode }) {
  return children;
}
