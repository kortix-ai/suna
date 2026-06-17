import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Kortix — The AI command center for your company',
  description:
    'A complete walkthrough of Kortix: the Autonomous Company Operating System. One repo that is your company, a workforce of AI agents, and everything is code you own.',
  robots: { index: false, follow: false },
};

export default function PresentationLayout({ children }: { children: React.ReactNode }) {
  // Full-screen deck — no marketing navbar/footer. Inherits fonts, theme tokens,
  // and providers from the root layout; the page itself is `fixed inset-0`.
  return <div className="h-dvh w-full overflow-hidden">{children}</div>;
}
