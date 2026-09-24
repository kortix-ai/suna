import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/company-as-code');

export default function CompanyAsCodeLayout({ children }: { children: ReactNode }) {
  return children;
}
