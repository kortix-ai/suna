'use client';

import { ConsentGate } from '@/components/consent-gate';
import Footer from '@/components/home/footer';
import { Navbar } from '@/components/home/navbar';
import { SmoothScroll } from '@/features/marketing/kit/smooth-scroll';
import { Children } from 'react';

// The "Request a demo" modal provider is mounted once in the root layout
// (src/app/[locale]/layout.tsx), so it is available here without a nested provider.

export function MarketingShell({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const routedChildren = Children.toArray(children);

  return (
    <div className="relative min-h-dvh w-full">
      <ConsentGate />
      <SmoothScroll />
      {/* The navbar owns the top row and links home, so the desktop Back
          (root layout) steps aside. */}
      <div className="fixed top-0 right-0 left-0 z-50" data-kx-titlebar-owner="">
        <Navbar />
      </div>
      {routedChildren}
      <Footer />
    </div>
  );
}
