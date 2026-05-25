'use client';

import { useTranslations } from 'next-intl';
// Permission usage analytics card. Two tables side by side:
//   • Top principals (members + tokens) by allowed-action count
//   • Most-used actions
// Plus a "by member" deep-dive row count so admins can scroll the full
// usage table. Backed by iam_action_usage (populated by every allowed
// authorize() call via the recorder).

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, BarChart3 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  listPermissionUsage,
  listTopPrincipals,
} from '@/lib/iam-client';
import { listAccountMembers } from '@/lib/projects-client';

interface AnalyticsCardProps {
  accountId: string;
}

export function AnalyticsCard({ accountId }: AnalyticsCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const topQuery = useQuery({
    queryKey: ['iam-analytics-top', accountId],
    queryFn: () => listTopPrincipals(accountId),
    staleTime: 60_000,
  });

  const usageQuery = useQuery({
    queryKey: ['iam-analytics-usage', accountId],
    queryFn: () => listPermissionUsage(accountId, 1000),
    staleTime: 60_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 60_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of membersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [membersQuery.data]);

  // Roll up usage by action across all principals — drives the
  // "most-used actions" panel.
  const actionTotals = useMemo(() => {
    const map = new Map<string, { count: number; lastUsedAt: string }>();
    for (const r of usageQuery.data ?? []) {
      const existing = map.get(r.action);
      if (existing) {
        existing.count += r.call_count;
        if (r.last_used_at > existing.lastUsedAt) existing.lastUsedAt = r.last_used_at;
      } else {
        map.set(r.action, { count: r.call_count, lastUsedAt: r.last_used_at });
      }
    }
    return Array.from(map.entries())
      .map(([action, v]) => ({ action, count: v.count, lastUsedAt: v.lastUsedAt }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }, [usageQuery.data]);

  const totalCalls = useMemo(
    () => (topQuery.data ?? []).reduce((acc, r) => acc + r.total_calls, 0),
    [topQuery.data],
  );

  return (
    <SectionCard
      title={tHardcodedUi.raw('componentsIamAnalyticsCard.line80JsxAttrTitlePermissionUsageAnalytics')}
      description={
        totalCalls > 0
          ? `${totalCalls.toLocaleString()} allowed actions tracked across ${(topQuery.data ?? []).length} principals.`
          : 'Use the system for a bit — analytics start populating after the next allowed action.'
      }
    >
      <div className="grid gap-6 px-6 py-5 lg:grid-cols-2">
        {/* Top principals */}
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
            <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
            {tHardcodedUi.raw('componentsIamAnalyticsCard.line92JsxTextTopPrincipals')}</h3>
          {topQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (topQuery.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamAnalyticsCard.line98JsxTextNoPrincipalsTrackedYet')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 font-medium">Principal</th>
                  <th className="py-2 text-right font-medium">Calls</th>
                  <th className="py-2 text-right font-medium">Distinct</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {(topQuery.data ?? []).map((r) => (
                  <tr key={`${r.principal_kind}|${r.principal_id}`} className="hover:bg-muted/20">
                    <td className="py-2">
                      <div className="flex items-center gap-1.5">
                        {r.principal_kind === 'token' && (
                          <Badge variant="outline" size="sm" className="text-[9px]">
                            PAT
                          </Badge>
                        )}
                        <span className={r.principal_kind === 'token' ? 'font-mono text-[11px] text-muted-foreground' : 'text-foreground'}>
                          {r.principal_kind === 'user'
                            ? emailByUserId.get(r.principal_id) ?? r.principal_id
                            : r.principal_id}
                        </span>
                      </div>
                    </td>
                    <td className="py-2 text-right font-mono text-foreground">
                      {r.total_calls.toLocaleString()}
                    </td>
                    <td className="py-2 text-right text-muted-foreground">
                      {r.distinct_actions}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Top actions */}
        <div>
          <h3 className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
            <Activity className="h-3.5 w-3.5 text-muted-foreground" />
            {tHardcodedUi.raw('componentsIamAnalyticsCard.line143JsxTextMostUsedActions')}</h3>
          {usageQuery.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : actionTotals.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {tHardcodedUi.raw('componentsIamAnalyticsCard.line149JsxTextNoActionsTrackedYet')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 font-medium">Action</th>
                  <th className="py-2 text-right font-medium">Calls</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {actionTotals.map((r) => (
                  <tr key={r.action} className="hover:bg-muted/20">
                    <td className="py-2 font-mono text-[11px] text-foreground">{r.action}</td>
                    <td className="py-2 text-right font-mono text-foreground">
                      {r.count.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
