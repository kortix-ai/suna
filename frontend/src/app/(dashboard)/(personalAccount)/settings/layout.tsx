'use client';

import { Separator } from '@/components/ui/separator';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isLocalMode } from '@/lib/config';

export default function PersonalAccountSettingsPage({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const items = [
    // { name: "Profile", href: "/settings" },
    // { name: "Teams", href: "/settings/teams" },
    { name: 'Billing', href: '/settings/billing' },
    { name: 'Usage Logs', href: '/settings/usage-logs' },
    ...(isLocalMode() ? [{ name: 'Local .Env Manager', href: '/settings/env-manager' }] : []),
  ];
  return (
    <>
      <div className="space-y-6 w-full">
        <Separator className="border-subtle dark:border-white/10" />
        <div className="flex flex-col space-y-8 lg:flex-row lg:space-x-12 lg:space-y-0 w-full max-w-7xl mx-auto px-4">
          <aside className="lg:w-1/4 p-1">
            <nav className="flex flex-col space-y-1">
              {items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${pathname === item.href
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-accent-foreground'}`}
                >
                  {item.name}
                </Link>
              ))}
            </nav>
          </aside>
          <div className="flex-1 bg-card-bg dark:bg-background-secondary p-6 rounded-2xl border border-subtle dark:border-white/10 shadow-custom">
            {children}
          </div>
        </div>
      </div>
    </>
  );
}
