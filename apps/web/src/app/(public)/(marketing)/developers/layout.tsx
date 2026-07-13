import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/developers');

export default function DevelopersLayout({ children }: { children: ReactNode }) {
  return children;
}
