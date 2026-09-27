import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/solutions');

export default function SolutionsLayout({ children }: { children: ReactNode }) {
  return children;
}
