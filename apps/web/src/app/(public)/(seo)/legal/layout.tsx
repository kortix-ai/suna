import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/legal');

export default function LegalLayout({ children }: { children: ReactNode }) {
  return children;
}
