'use client';

import { useFirm } from '@/components/access';
import { PageBody, PageHeader } from '@/components/page';
import { isAdmin } from '@/lib/roles';
import { cn } from '@kortix/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
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
      <nav aria-label="Settings" className="mt-5 flex gap-4 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={path === t.href ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 pb-2 text-sm transition-colors',
              path === t.href ? 'border-brand font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="mt-6">{children}</div>
    </PageBody>
  );
}
