import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Internal living design-system reference — public for sharing, not for search.
export const metadata: Metadata = {
  title: 'Design System',
  robots: { index: false, follow: false },
};

export default function DesignSystemLayout({ children }: { children: ReactNode }) {
  return children;
}
