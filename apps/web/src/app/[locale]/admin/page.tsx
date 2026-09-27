'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import {
  ArrowRightIcon,
  ChartLineUpIcon,
  CubeIcon,
  KanbanIcon,
  UsersIcon,
  WrenchIcon,
  type Icon,
} from '@phosphor-icons/react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

import { useOpsOverview } from '@/hooks/admin/use-ops-overview';
import { useLocalizedUiCatalog } from '@/i18n/use-localized-ui-catalog';
import { cn } from '@/lib/utils';

import { AdminPageShell } from './_components/admin-page-shell';
import { AdminSection } from './_components/admin-panel';
import { StatGrid, StatGridSkeleton, StatTile } from './_components/stat-tile';

/** Sections that used to live behind `?section=` on this page. */
const LEGACY_SECTION_REDIRECTS: Record<string, string> = {
  instances: '/admin/sandboxes',
  accounts: '/admin/accounts',
};

const DESTINATIONS: { href: string; label: string; description: string; icon: Icon }[] = [
  {
    href: '/admin/accounts',
    label: 'Accounts',
    description: 'Tiers, credits, trials, entitlements, members and billing state, per account.',
    icon: UsersIcon,
  },
  {
    href: '/admin/projects',
    label: 'Projects',
    description: 'Every project across every account, most-active first.',
    icon: KanbanIcon,
  },
  {
    href: '/admin/analytics',
    label: 'Analytics',
    description: 'Daily sessions, active accounts and credit burn.',
    icon: ChartLineUpIcon,
  },
  {
    href: '/admin/sandboxes',
    label: 'Sandboxes',
    description: 'Provider split, failover, the live fleet, and provisioning latency.',
    icon: CubeIcon,
  },
  {
    href: '/admin/utils',
    label: 'Maintenance',
    description: 'System-wide banners and the full-lockdown switch.',
    icon: WrenchIcon,
  },
];

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

export default function AdminOverviewPage() {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const searchParams = useSearchParams();
  const legacySection = searchParams.get('section');

  useEffect(() => {
    const destination = legacySection ? LEGACY_SECTION_REDIRECTS[legacySection] : undefined;
    if (destination) router.replace(destination);
  }, [legacySection, router]);

  const { data, isLoading } = useOpsOverview();
  const destinations = useLocalizedUiCatalog(DESTINATIONS);

  const erroredSandboxes = data?.sandboxes.errored ?? 0;
  const erroredSessions = data?.sessions.errored ?? 0;
  const queued = data?.queues.queued_total ?? 0;
  const apiOk = data?.api.status === 'ok';

  return (
    <AdminPageShell
      title={tI18nComplete.raw('textd4b1ea5708dd')}
      description={tI18nComplete.raw('text211be77ddd51')}
    >
      <AdminSection
        title={tI18nComplete.raw('text55898449eb74')}
        description={tI18nComplete.raw('text75779b882b3d')}
      >
        {isLoading ? (
          <StatGridSkeleton />
        ) : (
          <StatGrid>
            <StatTile
              label="API"
              value={data ? data.api.status.toUpperCase() : '—'}
              hint={data?.api.env}
              tone={apiOk ? 'success' : 'danger'}
            />
            <StatTile
              label={tI18nComplete.raw('text03a66748075e')}
              value={erroredSandboxes.toLocaleString()}
              hint={tI18nComplete.raw('text40b4051ad68e')}
              tone={erroredSandboxes > 0 ? 'danger' : 'default'}
            />
            <StatTile
              label={tI18nComplete.raw('textc92bd77c8ce2')}
              value={erroredSessions.toLocaleString()}
              hint={tI18nComplete.raw('text40b4051ad68e')}
              tone={erroredSessions > 0 ? 'danger' : 'default'}
            />
            <StatTile
              label={tI18nComplete.raw('texta607b581223a')}
              value={queued.toLocaleString()}
              hint={tI18nComplete.raw('text740edcecbc2a')}
              tone={queued > 0 ? 'warning' : 'default'}
            />
          </StatGrid>
        )}
      </AdminSection>

      <AdminSection
        title={tI18nComplete.raw('textc78ffe195710')}
        description={tI18nComplete.raw('text80037a202e3f')}
      >
        {isLoading ? (
          <StatGridSkeleton />
        ) : (
          <StatGrid>
            <StatTile
              label={tI18nComplete.raw('text8a7c8b67fe8b')}
              value={(data?.totals.accounts ?? 0).toLocaleString()}
            />
            <StatTile
              label={tI18nComplete.raw('text04e2a9728af7')}
              value={(data?.totals.projects ?? 0).toLocaleString()}
            />
            <StatTile
              label={tI18nComplete.raw('textee907488be07')}
              value={(data?.usage.calls_24h ?? 0).toLocaleString()}
            />
            <StatTile
              label={tI18nComplete.raw('textcae24ccc3b44')}
              value={usd.format(data?.usage.cost_usd_24h ?? 0)}
            />
          </StatGrid>
        )}
      </AdminSection>

      <AdminSection
        title={tI18nComplete.raw('textacf0b83e8622')}
        description={tI18nComplete.raw('textb3feb3946ecf')}
      >
        {/* A chooser, so it is one decision per line rather than a grid of
            equally-weighted cards — the shape `CustomizeIndexPage` settled on
            for the same job. No stagger: this page is opened many times a day
            and the delay would be billed to the operator on every one. */}
        <nav
          aria-label={tI18nComplete.raw('text99c62879ad37')}
          className="border-border/60 border-y"
        >
          {destinations.map((item, index) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch
              className={cn(
                'group hover:bg-hover focus-visible:ring-ring relative -mx-3 flex items-center gap-4 rounded-md px-3 py-4',
                'duration-fast transition-colors ease-out outline-none focus-visible:ring-2',
                index > 0 && 'border-border/60 border-t',
              )}
            >
              <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-sm">
                <item.icon className="text-foreground size-5 shrink-0" />
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <span className="text-foreground block text-sm font-medium">{item.label}</span>
                <span className="text-muted-foreground block text-xs leading-relaxed text-pretty">
                  {item.description}
                </span>
              </span>
              {/* The one moving part, and it moves on focus as well as hover so
                  the Tab key and the pointer give the same answer. */}
              <ArrowRightIcon
                aria-hidden
                className={cn(
                  'text-muted-foreground size-4 shrink-0 -translate-x-1 opacity-0',
                  'duration-fast transition-[opacity,transform] ease-out',
                  'group-hover:translate-x-0 group-hover:opacity-100',
                  'group-focus-visible:translate-x-0 group-focus-visible:opacity-100',
                  'motion-reduce:translate-x-0 motion-reduce:transition-none',
                )}
              />
            </Link>
          ))}
        </nav>
      </AdminSection>
    </AdminPageShell>
  );
}
