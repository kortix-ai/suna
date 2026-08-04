import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { localizedMarketingMetadata } from '@/lib/seo/metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedMarketingMetadata('/legal/terms');
}

export default function TermsLayout({ children }: { children: ReactNode }) {
  return children;
}
