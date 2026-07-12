'use client';

// Self-serve "enterprise demo" toggle. Enterprise features (SSO, SCIM, …) are
// normally sales-assigned via the enterprise tier; this switch lets any account
// admin flip on an interactive PREVIEW of the whole surface — no sales contact,
// no billing change — so prospects can evaluate it and we can dogfood in dev.
// It is explicitly a demo: real production use still requires a signed
// Enterprise agreement (the "Request access" link below).

import { toast } from '@/lib/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';

import { ENTERPRISE_PAGE_URL } from '@/components/iam/enterprise-upsell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { accountStateKeys } from '@/hooks/billing/use-account-state';
import { getEnterpriseDemo, setEnterpriseDemo } from '@/lib/iam-client';

interface EnterpriseDemoCardProps {
  accountId: string;
  canManage: boolean;
}

export function EnterpriseDemoCard({ accountId, canManage }: EnterpriseDemoCardProps) {
  const queryClient = useQueryClient();

  const stateQuery = useQuery({
    queryKey: ['iam-enterprise-demo', accountId],
    queryFn: () => getEnterpriseDemo(accountId),
    staleTime: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => setEnterpriseDemo(accountId, enabled),
    onSuccess: (enabled) => {
      toast.success(enabled ? 'Enterprise demo enabled' : 'Enterprise demo disabled');
      // Entitlements changed — refetch account state so the gate (`sso`/`scim`
      // entitlements) flips and the SSO/SCIM cards appear/disappear immediately,
      // plus the enterprise cards that read their own state.
      queryClient.invalidateQueries({ queryKey: accountStateKeys.state(accountId) });
      queryClient.invalidateQueries({ queryKey: ['iam-enterprise-demo', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-scim', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update the demo'),
  });

  const enabled = stateQuery.data ?? false;

  return (
    <section className="border-border/70 bg-card rounded-xl border">
      <header className="px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-foreground flex items-center gap-2 text-base font-semibold">
              <FlaskConical className="text-muted-foreground h-4 w-4" />
              Enterprise features
              <Badge
                variant="outline"
                size="sm"
                className="border-amber-500/40 bg-amber-500/10 text-[10px] font-normal text-amber-700 dark:text-amber-300"
              >
                demo
              </Badge>
            </h2>
            <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">
              Turn on an interactive preview of the enterprise surface — SSO, SCIM, advanced RBAC,
              and audit logs — for this account. This is an evaluation demo, not a production plan.
            </p>
          </div>
          {stateQuery.isLoading ? (
            <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
          ) : (
            <Switch
              checked={enabled}
              disabled={!canManage || toggleMutation.isPending}
              onCheckedChange={(next) => toggleMutation.mutate(next)}
              aria-label="Toggle enterprise features demo"
              className="shrink-0"
            />
          )}
        </div>

        <div className="border-border/60 mt-4 border-t pt-3">
          <p className="text-muted-foreground text-xs">
            For real enterprise use — production SLA, DPA, and support — you must talk to us to
            upgrade to the Enterprise plan.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href={ENTERPRISE_PAGE_URL} target="_blank" rel="noreferrer">
              Request enterprise access
            </a>
          </Button>
        </div>
      </header>
    </section>
  );
}
