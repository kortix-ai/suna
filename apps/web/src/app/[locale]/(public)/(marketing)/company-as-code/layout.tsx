import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/company-as-code');
}

export default function CompanyAsCodeLayout({ children }: { children: ReactNode }) {
  return children;
}
