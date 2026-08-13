import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Kortix — Security walkthrough',
  description:
    'A guided walkthrough of how Kortix contains agents: one sandbox per session, connector keys the machine never holds, a human gate before anything reaches main, and a record of every action.',
  robots: { index: false, follow: false },
};

export default function SecurityPresentationLayout({ children }: { children: React.ReactNode }) {
  return children;
}
