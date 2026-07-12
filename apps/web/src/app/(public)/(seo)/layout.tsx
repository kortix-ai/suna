'use client';

import { ConsentGate } from '@/components/consent-gate';
import Footer from '@/components/home/footer';
import { Navbar } from '@/components/home/navbar';

// The "Request a demo" modal provider is mounted once in the root layout
// (src/app/layout.tsx), so it is available here without a nested provider.

export default function SeoLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="relative min-h-dvh w-full">
      <ConsentGate />
      <div className="fixed top-0 right-0 left-0 z-50">
        <Navbar isAbsolute />
      </div>
      {children}
      <Footer />
    </div>
  );
}
