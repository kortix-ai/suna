import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/channels');

export default function ChannelsLayout({ children }: { children: ReactNode }) {
  return children;
}
