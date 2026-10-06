import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/agent-computer');
}

export default function AgentComputerLayout({ children }: { children: ReactNode }) {
  return children;
}
