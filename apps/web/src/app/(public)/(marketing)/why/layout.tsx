import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/why');

export default function WhyLayout({ children }: { children: ReactNode }) {
  return children;
}
