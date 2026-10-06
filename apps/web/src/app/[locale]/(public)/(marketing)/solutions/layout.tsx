import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/solutions');
}

export default function SolutionsLayout({ children }: { children: ReactNode }) {
  return children;
}
