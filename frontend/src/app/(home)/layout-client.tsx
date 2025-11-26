'use client';

import { Navbar } from '@/components/home/navbar';
import { isLocalMode } from '@/lib/config';
import { usePathname } from 'next/navigation';

export function HomeLayoutClient({
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
      <Navbar tabs={tabs} />
      {children}
    </div>
  );
}

