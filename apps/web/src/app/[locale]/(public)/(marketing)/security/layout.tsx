import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/security');

export default function SecurityLayout({ children }: { children: ReactNode }) {
  return children;
}
