import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Token-gated connect links must never enter a search index.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function ConnectAppTokenLayout({ children }: { children: ReactNode }) {
  return children;
}
