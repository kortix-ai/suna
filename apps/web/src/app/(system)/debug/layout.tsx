import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Dev-only visual harnesses — never a search result.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function DebugLayout({ children }: { children: ReactNode }) {
  return children;
}
