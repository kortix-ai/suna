'use client';


import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  ActivityIcon as Activity,
  ArrowRightIcon as ArrowRight,
  KanbanIcon as FolderKanban,
  SquaresFourIcon as LayoutDashboard,
  UsersIcon as Users,
  WrenchIcon as Wrench,
  type Icon as LucideIcon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { useOpsOverview } from '@/hooks/admin/use-ops-overview';

import { SectionContainer, SectionHeader, StatPill, StatRow } from './_components/section-header';

const LEGACY_SECTION_REDIRECTS: Record<string, string> = {
  instances: '/admin/sandboxes',
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

  const { data } = useOpsOverview();

  return (
    <SectionContainer>
      <SectionHeader
        icon={LayoutDashboard}
        title={'Admin overview'}
        description={'Production support entrypoint. Operations is the source of truth for live platform health.'}
      />

      <StatRow>
        <StatPill
          label="API"
          value={data?.api.status.toUpperCase() ?? '...'}
          hint={data?.api.env}
          tone={data?.api.status === 'ok' ? 'success' : 'warning'}
        />
        <StatPill label="Accounts" value={(data?.totals.accounts ?? 0).toLocaleString()} />
        <StatPill
          label={'Errored sandboxes'}
          value={data?.sandboxes.errored ?? 0}
          tone={(data?.sandboxes.errored ?? 0) > 0 ? 'danger' : 'success'}
        />
        <StatPill
          label={'Queued work'}
          value={data?.queues.queued_total ?? 0}
          tone={(data?.queues.queued_total ?? 0) > 0 ? 'warning' : 'success'}
        />
      </StatRow>

      <div className="grid gap-3 md:grid-cols-2">
        <QuickLink
          href="/admin/accounts"
          icon={Users}
          title="Accounts"
          description={'Tiers, credits, trials, entitlements, members, and billing state per account.'}
        />
        <QuickLink
          href="/admin/projects"
          icon={FolderKanban}
          title="Projects"
          description={'Every project across all accounts, most active first.'}
        />
        <QuickLink
          href="/admin/sandboxes"
          icon={Activity}
          title="Sandboxes"
          description={'Provider distribution, failover, sandbox fleet, and migrations.'}
        />
        <QuickLink
          href="/admin/utils"
          icon={Wrench}
          title="Maintenance"
          description={'Support workflows for account access, technical issues, and operational recovery.'}
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
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group border-border/60 bg-card hover:border-border hover:bg-muted/30 relative flex flex-col gap-3 rounded-2xl border p-4 transition-colors"
    >
      <div className="flex items-center justify-between">
        <EntityAvatar icon={Icon} size="md" />
        <ArrowRight className="text-muted-foreground h-4 w-4 opacity-0 transition-[opacity,translate] group-hover:translate-x-0.5 group-hover:opacity-100" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-muted-foreground text-xs leading-relaxed">{description}</p>
      </div>
    </Link>
  );
}
