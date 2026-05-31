'use client';

import Footer from '@/components/home/footer';
import { Navbar } from '@/components/home/navbar';
import { Children } from 'react';

export default function HomeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const routedChildren = Children.toArray(children);

  return (
    <div className="relative min-h-dvh w-full">
      <div className="fixed top-0 right-0 left-0 z-50">
        <Navbar isAbsolute />
      </div>
      {routedChildren}
      <Footer />
    </div>
  );
}
