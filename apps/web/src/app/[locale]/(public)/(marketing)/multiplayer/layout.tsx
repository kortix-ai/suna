import { localizedMarketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

export function generateMetadata() {
  return localizedMarketingMetadata('/multiplayer');
}

export default function MultiplayerLayout({ children }: { children: ReactNode }) {
  return children;
}
