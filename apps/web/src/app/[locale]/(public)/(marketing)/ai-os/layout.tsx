import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/ai-os');

export default function AiOsLayout({ children }: { children: ReactNode }) {
  return children;
}
