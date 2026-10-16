import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// An embed carries a capability token in its URL and must never enter a
// search index, like every other token-gated public surface.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function EmbedChatTokenLayout({ children }: { children: ReactNode }) {
  return children;
}
