import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/enterprise');

export default function EnterpriseLayout({ children }: { children: ReactNode }) {
  return children;
}
