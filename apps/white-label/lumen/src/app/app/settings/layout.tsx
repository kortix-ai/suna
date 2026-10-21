'use client';

import { useFirm } from '@/components/access';
import { PageBody, PageHeader } from '@/components/page';
import { isAdmin } from '@/lib/roles';
import { cn } from '@kortix/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/app/settings/account', label: 'Your account', admin: false },
  { href: '/app/settings/firm', label: 'Firm', admin: false },
  { href: '/app/settings/members', label: 'Members', admin: true },
  { href: '/app/settings/billing', label: 'Billing', admin: false },
  { href: '/app/settings/usage', label: 'Usage', admin: true },
  { href: '/app/settings/audit', label: 'Audit log', admin: true },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const firm = useFirm();
  const path = usePathname();
  const tabs = TABS.filter((t) => !t.admin || isAdmin(firm.role));
  return (
    <PageBody>
      <PageHeader title="Settings" description={firm.name} />
      <div className="mt-6 grid gap-6 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10">
        <nav aria-label="Settings" className="scrollbar-none -mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:px-0">
          {tabs.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              aria-current={path === t.href ? 'page' : undefined}
              className={cn(
                'shrink-0 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                path === t.href ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </PageBody>
  );
}
