import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Token-gated session shares must never enter a search index.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ShareSessionTokenLayout({ children }: { children: ReactNode }) {
  return children;
}
