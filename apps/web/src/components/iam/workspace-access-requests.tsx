'use client';

/**
 * People asking to join this workspace, at the top of Members: Approve makes
 * them a Member, Decline closes the request. A 1:1 workspace has one roster,
 * so its requests sit with it instead of behind a per-workspace Access pane.
 * Renders nothing while there is no pending request.
 */

import {
  approveProjectAccessRequest,
  listProjectAccessRequests,
  rejectProjectAccessRequest,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Button } from '@kortix/ui/button';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { errorToast, successToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';

export function WorkspaceAccessRequests({
  workspaceId,
  canManage,
  onDecided,
}: {
  workspaceId: string;
  /** `project.members.manage`: only then are requests listed and decided. */
  canManage: boolean;
  onDecided?: () => void;
}) {
  const t = useTranslations('workspaces.accessRequests');
  const queryClient = useQueryClient();
  const requestsQuery = useQuery({
    queryKey: qk.project.accessRequests(workspaceId),
    queryFn: () => listProjectAccessRequests(workspaceId),
    ...contract('inventory'),
    enabled: canManage,
  });
  const requests = (requestsQuery.data?.requests ?? []).filter((request) => request.status === 'pending');

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      approve ? approveProjectAccessRequest(workspaceId, id, 'member') : rejectProjectAccessRequest(workspaceId, id),
    onSuccess: (_result, { approve }) => {
      successToast(approve ? t('approvedToast') : t('declinedToast'));
      void queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(workspaceId) });
      if (approve) onDecided?.();
    },
    onError: (error: Error) => errorToast(error.message || t('decideFailed')),
  });

  if (!canManage || requests.length === 0) return null;

  return (
    <section className="space-y-2" data-testid="workspace-access-requests">
      <Label>{t('title', { count: requests.length })}</Label>
      <ul className="bg-popover divide-y rounded-md border">
        {requests.map((request) => {
          const busy = decide.isPending && decide.variables?.id === request.request_id;
          return (
            <li key={request.request_id} className="flex items-center gap-3 px-4 py-2.5">
              <UserAvatar email={request.requester_email} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="text-foreground block truncate text-sm">{request.requester_email}</span>
                {request.message ? (
                  <span className="text-muted-foreground block truncate text-xs">{request.message}</span>
                ) : null}
              </span>
              {busy ? <Loading className="text-muted-foreground size-4 shrink-0" /> : null}
              <Button
                variant="ghost"
                size="sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: request.request_id, approve: false })}
              >
                {t('decline')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: request.request_id, approve: true })}
              >
                {t('approve')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
