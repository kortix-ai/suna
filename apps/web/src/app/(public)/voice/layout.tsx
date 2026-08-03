import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// Token-gated live voice-call join pages must never enter a search index.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function VoiceLayout({ children }: { children: ReactNode }) {
  return children;
}
