import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/automations');

export default function AutomationsLayout({ children }: { children: ReactNode }) {
  return children;
}
