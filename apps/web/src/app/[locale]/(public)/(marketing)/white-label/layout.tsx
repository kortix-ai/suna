import { marketingMetadata } from '@/lib/seo/metadata';
import type { ReactNode } from 'react';

// English-only copy (features/marketing/white-label/content.ts), so the page
// canonicalizes to the English URL and emits no hreflang set.
export function generateMetadata() {
  return marketingMetadata('/white-label');
}

export default function WhiteLabelLayout({ children }: { children: ReactNode }) {
  return children;
}
