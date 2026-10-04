import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/automations');
}

export default function AutomationsLayout({ children }: { children: ReactNode }) {
  return children;
}
