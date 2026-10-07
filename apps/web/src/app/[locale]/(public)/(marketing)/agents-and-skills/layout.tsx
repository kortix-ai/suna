import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/agents-and-skills');
}

export default function AgentsAndSkillsLayout({ children }: { children: ReactNode }) {
  return children;
}
