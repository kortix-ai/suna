import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/enterprise');
}

export default function EnterpriseLayout({ children }: { children: ReactNode }) {
  return children;
}
