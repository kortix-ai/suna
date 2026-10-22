import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/channels');
}

export default function ChannelsLayout({ children }: { children: ReactNode }) {
  return children;
}
