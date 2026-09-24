import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/self-hosted');

export default function SelfHostedLayout({ children }: { children: ReactNode }) {
  return children;
}
