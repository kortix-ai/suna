'use client';

import { Navbar } from '@/components/home/sections/navbar';
import { isLocalMode } from '@/lib/config';
import { usePathname } from 'next/navigation';

export default function HomeLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const pathname = usePathname();

  // Determine tabs based on local mode and current path
  let tabs: string[] | undefined;
  if (isLocalMode()) {
    // On consumer page (/), show home navigation links + enterprise
    // On enterprise page, only show enterprise
    tabs = pathname === '/enterprise' ? ['enterprise'] : ['home', 'enterprise'];
  }

  return (
    <div className="w-full relative">
      {!isLocalMode() && <div className="block w-px h-full border-l border-border fixed top-0 left-6 z-10"></div>}
      {!isLocalMode() && <div className="block w-px h-full border-r border-border fixed top-0 right-6 z-10"></div>}
      <Navbar tabs={tabs} />
      {children}
    </div>
  );
}
