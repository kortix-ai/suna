import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/self-hosted');
}

export default function SelfHostedLayout({ children }: { children: ReactNode }) {
  return children;
}
