import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/agent-computer');

export default function AgentComputerLayout({ children }: { children: ReactNode }) {
  return children;
}
