import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/integrations');

export default function IntegrationsLayout({ children }: { children: ReactNode }) {
  return children;
}
