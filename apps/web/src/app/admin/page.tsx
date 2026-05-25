'use client';

import { useTranslations } from 'next-intl';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Activity, ArrowRight, LayoutDashboard, Wrench, type LucideIcon } from 'lucide-react';
import { EntityAvatar } from '@/components/ui/entity-avatar';

import { useOpsOverview } from '@/hooks/admin/use-ops-overview';

import {
  SectionContainer,
  SectionHeader,
  StatPill,
  StatRow,
} from './_components/section-header';

const LEGACY_SECTION_REDIRECTS: Record<string, string> = {
  instances: '/admin/ops',
  accounts: '/admin/accounts',
};

export default function AdminOverviewPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        title={tHardcodedUi.raw('appAdminPage.line40JsxAttrTitleAdminOverview')}
        description={tHardcodedUi.raw('appAdminPage.line41JsxAttrDescriptionProductionSupportEntrypointOperationsIsTheSourceOf')}
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
          label={tHardcodedUi.raw('appAdminPage.line53JsxAttrLabelErroredSandboxes')}
          value={data?.sandboxes.errored ?? 0}
          tone={(data?.sandboxes.errored ?? 0) > 0 ? 'danger' : 'success'}
        />
        <StatPill
          label={tHardcodedUi.raw('appAdminPage.line58JsxAttrLabelQueuedWork')}
          value={data?.queues.queued_total ?? 0}
          tone={(data?.queues.queued_total ?? 0) > 0 ? 'warning' : 'success'}
        />
      </StatRow>

      <div className="grid gap-3 md:grid-cols-2">
        <QuickLink
          href="/admin/ops"
          icon={Activity}
          title="Operations"
          description={tHardcodedUi.raw('appAdminPage.line69JsxAttrDescriptionApiSessionsSandboxesQueuesAuditEventsUsageAnd')}
        />
        <QuickLink
          href="/admin/utils"
          icon={Wrench}
          title="Maintenance"
          description={tHardcodedUi.raw('appAdminPage.line75JsxAttrDescriptionSupportWorkflowsForAccountAccessTechnicalIssuesAnd')}
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
      className="group relative flex flex-col gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-border hover:bg-muted/30"
    >
      <div className="flex items-center justify-between">
        <EntityAvatar icon={Icon} size="md" />
        <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
      </div>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
      </div>
    </Link>
  );
}
