import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Kortix — Product deck',
  description:
    'A complete, in-depth walkthrough of the Kortix platform — the Autonomous Company Operating System.',
  robots: { index: false, follow: false },
};

export default function PlatformPresentationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
