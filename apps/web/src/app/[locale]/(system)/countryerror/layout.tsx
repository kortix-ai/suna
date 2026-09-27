import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Error surface — never a search result.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function CountryErrorLayout({ children }: { children: ReactNode }) {
  return children;
}
