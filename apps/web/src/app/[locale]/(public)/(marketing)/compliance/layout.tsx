import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/compliance');
}

export default function ComplianceLayout({ children }: { children: ReactNode }) {
  return children;
}
