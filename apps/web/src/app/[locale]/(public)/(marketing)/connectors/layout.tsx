import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/connectors');
}

export default function ConnectorsLayout({ children }: { children: ReactNode }) {
  return children;
}
