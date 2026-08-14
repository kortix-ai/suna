import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Kortix — Presentations',
  description: 'Internal Kortix presentations.',
  robots: { index: false, follow: false },
};

/**
 * Full-bleed shell for every deck and the index — no marketing navbar or
 * footer. Fonts, theme tokens and providers come from the root layout; a deck
 * page positions itself `fixed inset-0` inside this.
 */
export default function PresentationsLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh w-full overflow-hidden">{children}</div>;
}
