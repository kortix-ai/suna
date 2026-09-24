import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export const metadata = marketingMetadata('/agents-and-skills');

export default function AgentsAndSkillsLayout({ children }: { children: ReactNode }) {
  return children;
}
