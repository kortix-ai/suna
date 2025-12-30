'use client';

import { Navbar } from '@/components/home/navbar';

export default function HomeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="w-full relative">
      <Navbar />
      {children}
    </div>
  );
}
