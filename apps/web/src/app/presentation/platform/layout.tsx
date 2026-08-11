import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'dosco — Product deck',
  description:
    'A complete, in-depth walkthrough of the dosco platform — the agent network for your company.',
  robots: { index: false, follow: false },
};

export default function PlatformPresentationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
