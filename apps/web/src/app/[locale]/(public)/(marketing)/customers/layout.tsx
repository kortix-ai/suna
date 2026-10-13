import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/customers');
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
