'use client';

/**
 * Connected apps: the apps this person approved with "Sign in with Kortix" —
 * MCP clients such as Claude Code or Cursor, and accounts' own OAuth apps.
 * Per person, across all accounts, so it sits in the personal Tokens tab next
 * to the keys it is the counterpart of. The consent screen promises it: "You
 * can revoke access at any time in your account settings."
 *
 * Revoke deletes the consent (the app must ask again) and revokes every live
 * token the app holds for this person; they stop working on their next
 * request (`DELETE /v1/oauth/grants/:clientId`).
 */

import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { AccessList, AccessRow } from '@/features/workspace/shared/access';
import { useTranslations } from '@/i18n/use-translations';
import { listOAuthGrants, revokeOAuthGrant, type OAuthGrant } from '@kortix/sdk';
import { PlugsConnectedIcon, ProhibitIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const CONNECTED_APPS_KEY = ['oauth-grants'];

export interface ConnectedAppMetaCopy {
  lastActive: (time: string) => string;
  approved: (time: string) => string;
  relativeTime: (iso: string) => string;
}

/** The meta line under an app's name: where it signs in, and when it was last active. */
export function connectedAppMetaParts(grant: OAuthGrant, copy: ConnectedAppMetaCopy): string[] {
  const parts = [...grant.redirect_hosts];
  if (grant.last_active_at) parts.push(copy.lastActive(copy.relativeTime(grant.last_active_at)));
  else if (grant.granted_at) parts.push(copy.approved(copy.relativeTime(grant.granted_at)));
  return parts;
}

export function ConnectedApps({ relativeTime }: { relativeTime: (iso: string) => string }) {
  const t = useTranslations('settings.connectedApps');
  const queryClient = useQueryClient();
  const [revokeTarget, setRevokeTarget] = useState<OAuthGrant | null>(null);

  const grantsQuery = useQuery({
    queryKey: CONNECTED_APPS_KEY,
    queryFn: listOAuthGrants,
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (grant: OAuthGrant) => revokeOAuthGrant(grant.client_id),
    onSuccess: () => {
      successToast(t('revoked'));
      queryClient.invalidateQueries({ queryKey: CONNECTED_APPS_KEY });
      setRevokeTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || t('revokeFailed')),
  });

  const grants = grantsQuery.data ?? [];

  return (
    <section className="space-y-3">
      <SettingsSectionHeader title={t('title')} description={t('description')} />
      {grantsQuery.isLoading ? (
        <Skeleton className="h-14 rounded-md" />
      ) : grantsQuery.isError ? (
        <ErrorState
          size="sm"
          title={t('loadFailed')}
          description={grantsQuery.error instanceof Error ? grantsQuery.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => grantsQuery.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      ) : grants.length === 0 ? (
        <EmptyState icon={PlugsConnectedIcon} size="sm" title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <AccessList>
          {grants.map((grant) => (
            <AccessRow
              key={grant.client_id}
              leading={<EntityAvatar icon={PlugsConnectedIcon} label={grant.name} size="sm" />}
              title={grant.name}
              badges={
                grant.self_registered ? (
                  <Badge variant="update" size="sm">
                    {t('unverified')}
                  </Badge>
                ) : undefined
              }
              metaParts={connectedAppMetaParts(grant, {
                lastActive: (time) => t('lastActive', { time }),
                approved: (time) => t('approved', { time }),
                relativeTime,
              })}
              kebab={[
                {
                  label: t('revokeApp'),
                  icon: <ProhibitIcon className="size-3.5 shrink-0" />,
                  variant: 'destructive',
                  onSelect: () => setRevokeTarget(grant),
                },
              ]}
              kebabLabel={t('actionsFor', { name: grant.name })}
              pending={revokeMutation.isPending && revokeTarget?.client_id === grant.client_id}
            />
          ))}
        </AccessList>
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t('revokeTitle')}
        description={revokeTarget ? t('revokeDescription', { name: revokeTarget.name }) : ''}
        confirmLabel={t('revoke')}
        confirmVariant="destructive"
        isPending={revokeMutation.isPending}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget);
        }}
      />
    </section>
  );
}
