'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, LayoutDashboard, Server, Users } from 'lucide-react';

import { useAdminAccounts } from '@/hooks/admin/use-admin-accounts';
import { useAdminSandboxes } from '@/hooks/admin/use-admin-sandboxes';

import {
  SectionContainer,
  SectionHeader,
  StatPill,
  StatRow,
} from './_components/section-header';

const LEGACY_SECTION_REDIRECTS: Record<string, string> = {
  instances: '/admin/instances',
  accounts: '/admin/accounts',
};

export default function AdminOverviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacySection = searchParams.get('section');

  useEffect(() => {
    if (legacySection && LEGACY_SECTION_REDIRECTS[legacySection]) {
      router.replace(LEGACY_SECTION_REDIRECTS[legacySection]);
    }
  }, [legacySection, router]);

  const { data: accounts } = useAdminAccounts({ page: 1, limit: 100 });
  const { data: sandboxes } = useAdminSandboxes({ page: 1, limit: 1 });

  const totalAccounts = accounts?.total ?? 0;
  const totalSandboxes = sandboxes?.total ?? 0;
  const paidAccounts = (accounts?.accounts ?? []).filter(
    (a) => a.tier && a.tier !== 'free',
  ).length;
  const totalCredits = (accounts?.accounts ?? []).reduce(
    (sum, a) => sum + Number(a.balance ?? 0),
    0,
  );

  return (
    <SectionContainer>
      <SectionHeader
        icon={LayoutDashboard}
        title="Admin overview"
        description="Fleet and account signals at a glance. Legacy tools are tucked away in the sidebar."
      />

      <StatRow>
        <StatPill label="Total accounts" value={totalAccounts.toLocaleString()} />
        <StatPill label="Total instances" value={totalSandboxes.toLocaleString()} />
        <StatPill
          label="Paid accounts"
          value={paidAccounts}
          hint="On top 100 accounts"
          tone="success"
        />
        <StatPill
          label="Credits on ledger"
          value={`$${totalCredits.toFixed(2)}`}
          hint="Across top 100 accounts"
        />
      </StatRow>

      <div className="grid gap-3 md:grid-cols-2">
        <QuickLink
          href="/admin/instances"
          icon={Server}
          title="Instances"
          description="Inspect every machine, open shared settings, and manage lifecycle actions."
        />
        <QuickLink
          href="/admin/accounts"
          icon={Users}
          title="Accounts"
          description="Users, billing, credit balances, grants, debits, and ledger history."
        />
      </div>
    </SectionContainer>
  );
}

function QuickLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group relative flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-border hover:bg-muted/30"
    >
      <div className="flex items-center justify-between">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-4 w-4" />
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </Link>
  );
}
