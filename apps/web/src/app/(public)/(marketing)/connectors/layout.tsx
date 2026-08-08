import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/connectors');

export default function ConnectorsLayout({ children }: { children: ReactNode }) {
  return children;
}
