'use client';

// Self-serve "enterprise demo" toggle. Enterprise features (SSO, SCIM, …) are
// normally sales-assigned via the enterprise tier; this switch lets any account
// admin flip on an interactive PREVIEW of the whole surface — no sales contact,
// no billing change — so prospects can evaluate it and we can dogfood in dev.
// It is explicitly a demo: real production use still requires a signed
// Enterprise agreement (the "Request access" link below).

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { accountStateKeys } from '@/hooks/billing/use-account-state';
import { getEnterpriseDemo, setEnterpriseDemo } from '@/lib/iam-client';

interface EnterpriseDemoCardProps {
  accountId: string;
  canManage: boolean;
}

export function EnterpriseDemoCard({ accountId, canManage }: EnterpriseDemoCardProps) {
  const queryClient = useQueryClient();
  const openDemo = useRequestDemo();

  const stateQuery = useQuery({
    queryKey: ['iam-enterprise-demo', accountId],
    queryFn: () => getEnterpriseDemo(accountId),
    staleTime: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => setEnterpriseDemo(accountId, enabled),
    onSuccess: (enabled) => {
      successToast(enabled ? 'Enterprise demo enabled' : 'Enterprise demo disabled');
      // Entitlements changed — refetch account state so the gate (`sso`/`scim`
      // entitlements) flips and the SSO/SCIM cards appear/disappear immediately,
      // plus the enterprise cards that read their own state.
      queryClient.invalidateQueries({ queryKey: accountStateKeys.state(accountId) });
      queryClient.invalidateQueries({ queryKey: ['iam-enterprise-demo', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-scim', accountId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update the demo'),
  });

  const enabled = stateQuery.data ?? false;

  return (
    <div className="bg-popover rounded-md border">
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <div className="min-w-0">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            Enterprise features
            <Badge variant="beta" size="sm">
              Demo
            </Badge>
          </p>
          <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">
            Turn on an interactive preview of SSO, SCIM, advanced RBAC, and audit logs for this
            account. Evaluation only, not a production plan.
          </p>
        </div>
        {stateQuery.isLoading ? (
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
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
      {/* The request-enterprise CTA lives on the EnterpriseUpsell panel below —
          one CTA per intent on the page. `openDemo` stays wired for the
          entitled state, where the upsell is hidden. */}
      {enabled ? (
        <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <p className="text-muted-foreground text-xs">
            For production use (SLA, DPA, support) upgrade to the Enterprise plan.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => openDemo({ source: 'accounts-enterprise-access' })}
          >
            Request enterprise access
          </Button>
        </div>
      ) : null}
    </div>
  );
}
