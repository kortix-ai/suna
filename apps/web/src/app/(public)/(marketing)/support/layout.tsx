import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/support');

export default function SupportLayout({ children }: { children: ReactNode }) {
  return children;
}
