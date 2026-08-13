'use client';

// "Enterprise demo" state card. Enterprise features (SSO, SCIM, …) are normally
// sales-assigned via the enterprise tier; the demo flag turns on an interactive
// PREVIEW of the whole surface — no billing change — so prospects can evaluate
// it and we can dogfood in dev. It is explicitly a demo: real production use
// still requires a signed Enterprise agreement (the "Request access" link).
//
// The WRITE is platform-admin-only. `PUT /v1/accounts/{id}/iam/enterprise-demo`
// answers 403 {code:'admin_required'} for everyone else, so an account admin
// sees the state read-only plus a "contact Kortix" hint instead of a switch
// that would only ever fail. Platform admins keep the working switch here; the
// operator console (/admin/accounts → Entitlements) is the other write path.
//
// **Renders bare `SettingsRow`s — mount it inside a `SettingsRowGroup`.** It
// used to draw its own bordered box with a `border-t` footer strip; both are
// rows now, in the Linear shape the rest of the settings panel uses (see
// `components/ui/settings-row.tsx`). The second row appears only while the
// preview is on, which is exactly when its CTA is reachable.
//
// The row no longer repeats the words "Enterprise features": the section
// heading directly above it already says that, and a heading whose only child
// restates it is a line the reader has to skip.

import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SettingsRow } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useRequestDemo } from '@/features/contact/request-demo-provider';
import { useAdminRole } from '@/hooks/admin/use-admin-role';
import { accountStateKeys } from '@/hooks/billing/use-account-state';
import { getEnterpriseDemo, setEnterpriseDemo } from '@/lib/iam-client';

interface EnterpriseDemoCardProps {
  accountId: string;
  canManage: boolean;
}

export function EnterpriseDemoCard({ accountId, canManage }: EnterpriseDemoCardProps) {
  const queryClient = useQueryClient();
  const openDemo = useRequestDemo();
  const adminRoleQuery = useAdminRole();
  const isPlatformAdmin = !!adminRoleQuery.data?.isAdmin;

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
  // Both queries must settle before the control renders: showing a switch and
  // then swapping it for a read-only badge one tick later reads as a bug.
  const isLoading = stateQuery.isLoading || adminRoleQuery.isLoading;

  return (
    <>
      <SettingsRow
        label={
          <>
            Turn on the preview
            <Badge variant="beta" size="sm">
              Demo
            </Badge>
          </>
        }
        description={
          !isLoading && !isPlatformAdmin
            ? 'Evaluation only, not a production plan. Contact Kortix to switch it on.'
            : 'Evaluation only, not a production plan.'
        }
      >
        {isLoading ? (
          <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
        ) : isPlatformAdmin ? (
          <Switch
            checked={enabled}
            disabled={!canManage || toggleMutation.isPending}
            onCheckedChange={(next) => toggleMutation.mutate(next)}
            aria-label="Toggle enterprise features demo"
            className="shrink-0"
          />
        ) : (
          <Badge variant={enabled ? 'success' : 'muted'} size="sm" className="shrink-0">
            {enabled ? 'On' : 'Off'}
          </Badge>
        )}
      </SettingsRow>
      {/* The request-enterprise CTA lives on the EnterpriseUpsell panel below —
          one CTA per intent on the page. `openDemo` stays wired for the
          entitled state, where the upsell is hidden. */}
      {enabled ? (
        <SettingsRow
          label="Production access"
          description="An SLA, a DPA, and support come with the Enterprise plan."
        >
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => openDemo({ source: 'accounts-enterprise-access' })}
          >
            Request access
          </Button>
        </SettingsRow>
      ) : null}
    </>
  );
}
