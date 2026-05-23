'use client';

import { useTranslations } from 'next-intl';
// Drift detection card on the Audit tab. Surfaces stale or
// cleanup-candidate IAM objects so admins can prune. Read-only —
// the report only proposes work; clicking through to the targets
// (member detail, group detail) is where actual deletions happen.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Recycle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { getDriftReport } from '@/lib/iam-client';

interface DriftCardProps {
  accountId: string;
}

export function DriftCard({ accountId }: DriftCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [lookback, setLookback] = useState(60);
  const query = useQuery({
    queryKey: ['iam-drift', accountId, lookback],
    queryFn: () => getDriftReport(accountId, lookback),
    staleTime: 5 * 60_000,
  });

  const report = query.data;
  const totalIssues =
    (report?.unused_policies.length ?? 0) +
    (report?.empty_groups.length ?? 0) +
    (report?.orphan_groups.length ?? 0) +
    (report?.expired_policies.length ?? 0);

  return (
    <SectionCard
      title={tHardcodedUi.raw('componentsIamDriftCard.line39JsxAttrTitleIAMDrift')}
      description={
        report
          ? totalIssues === 0
            ? 'No stale IAM objects detected. Tidy account.'
            : `${totalIssues} cleanup candidates found across policies and groups.`
          : 'Surface stale policies, empty groups, and expired rows for pruning.'
      }
      action={
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-muted-foreground">
            {tHardcodedUi.raw('componentsIamDriftCard.line50JsxTextLookbackNbsp')}<select
              value={lookback}
              onChange={(e) => setLookback(parseInt(e.target.value, 10))}
              className="rounded-md border border-border/60 bg-background px-1 py-0.5 text-xs"
            >
              <option value={30}>30d</option>
              <option value={60}>60d</option>
              <option value={90}>90d</option>
              <option value={180}>180d</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            className="gap-1.5"
          >
            {query.isFetching ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Recycle className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </div>
      }
    >
      <div className="space-y-5 px-6 py-5">
        {query.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !report ? (
          <p className="text-xs text-muted-foreground">
            {tHardcodedUi.raw('componentsIamDriftCard.line84JsxTextCouldnTLoadDriftReport')}</p>
        ) : (
          <>
            <DriftSection
              title={tHardcodedUi.raw('componentsIamDriftCard.line89JsxAttrTitleUnusedPolicies')}
              count={report.unused_policies.length}
              empty={tHardcodedUi.raw('componentsIamDriftCard.line91JsxAttrEmptyNoUnusedPolicies')}
              tone="amber"
            >
              {report.unused_policies.slice(0, 10).map((p) => (
                <li key={p.policy_id} className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" size="sm" className="text-[10px]">
                    {p.role_name}
                  </Badge>
                  <span className="text-muted-foreground">on</span>
                  <Badge variant="outline" size="sm" className="text-[10px]">
                    {p.scope_type}
                    {p.scope_id ? `:${p.scope_id.slice(0, 6)}…` : ''}
                  </Badge>
                  <span className="text-muted-foreground">for</span>
                  <span className="font-mono text-[11px] text-foreground">
                    {p.principal_type}:{p.principal_id.slice(0, 8)}…
                  </span>
                </li>
              ))}
            </DriftSection>

            <DriftSection
              title={tHardcodedUi.raw('componentsIamDriftCard.line113JsxAttrTitleExpiredPoliciesStillPresent')}
              count={report.expired_policies.length}
              empty={tHardcodedUi.raw('componentsIamDriftCard.line115JsxAttrEmptyNoExpiredPoliciesToCleanUp')}
              tone="amber"
            >
              {report.expired_policies.slice(0, 10).map((p) => (
                <li key={p.policy_id} className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" size="sm" className="text-[10px]">
                    expired {new Date(p.expires_at).toLocaleDateString()}
                  </Badge>
                  <span className="font-mono text-[11px] text-foreground">
                    {p.principal_type}:{p.principal_id.slice(0, 8)}…
                  </span>
                </li>
              ))}
            </DriftSection>

            <DriftSection
              title={tHardcodedUi.raw('componentsIamDriftCard.line131JsxAttrTitleEmptyGroupsNoMembers')}
              count={report.empty_groups.length}
              empty={tHardcodedUi.raw('componentsIamDriftCard.line133JsxAttrEmptyNoEmptyGroups')}
              tone="muted"
            >
              {report.empty_groups.slice(0, 10).map((g) => (
                <li key={g.group_id} className="text-foreground">{g.name}</li>
              ))}
            </DriftSection>

            <DriftSection
              title={tHardcodedUi.raw('componentsIamDriftCard.line142JsxAttrTitleOrphanGroupsNoPoliciesAttached')}
              count={report.orphan_groups.length}
              empty={tHardcodedUi.raw('componentsIamDriftCard.line144JsxAttrEmptyNoOrphanGroups')}
              tone="muted"
            >
              {report.orphan_groups.slice(0, 10).map((g) => (
                <li key={g.group_id} className="text-foreground">{g.name}</li>
              ))}
            </DriftSection>
          </>
        )}
      </div>
    </SectionCard>
  );
}

function DriftSection({
  title,
  count,
  empty,
  tone,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  tone: 'amber' | 'muted';
  children: React.ReactNode;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
        {count > 0 && tone === 'amber' && (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
        )}
        {title}
        <Badge variant="outline" size="sm" className="text-[10px]">
          {count}
        </Badge>
      </div>
      {count === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-1 text-xs">{children}</ul>
      )}
      {count > 10 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {tHardcodedUi.raw('componentsIamDriftCard.line189JsxTextShowingFirst10Of')}{count}{tHardcodedUi.raw('componentsIamDriftCard.line189JsxTextUseTheIAMAPIToEnumerateTheRest')}</p>
      )}
    </div>
  );
}
