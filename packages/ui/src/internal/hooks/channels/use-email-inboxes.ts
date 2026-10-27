'use client';

import {
  addEmailInbox,
  listEmailInboxes,
  removeEmailInbox,
  updateEmailInbox,
  type AddEmailInboxInput,
  type EmailInbox,
  type EmailSenderPolicy,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

export type { AddEmailInboxInput, EmailInbox };

/**
 * The project's email inboxes. Each inbox is one ACCOUNT on the `kortix_email`
 * connector profile, so the standard account surfaces (default, who can use
 * it) apply to it; these hooks add what only email has: the Resend inbox
 * behind the account, its address and who may email it.
 */
const inboxesKey = (projectId: string | null) => ['channels', 'email-inboxes', projectId ?? 'none'] as const;

/** Everything that shows an inbox: the inbox list, the account list, the connector page. */
function refreshInboxViews(qc: QueryClient, projectId: string) {
  void qc.invalidateQueries({ queryKey: inboxesKey(projectId) });
  void qc.invalidateQueries({ queryKey: ['connections', projectId] });
  void qc.invalidateQueries({ queryKey: qk.project.connectors(projectId) });
  void qc.invalidateQueries({ queryKey: ['channels', 'email-install'] });
}

/** The inboxes the viewer can use. Pass null to keep the query off (flag off). */
export function useEmailInboxes(projectId: string | null) {
  return useQuery({
    queryKey: inboxesKey(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
    queryFn: async (): Promise<EmailInbox[]> => (projectId ? listEmailInboxes(projectId) : []),
  });
}

export function useAddEmailInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: AddEmailInboxInput & { projectId: string }) =>
      addEmailInbox(projectId, input),
    onSuccess: (_inbox, { projectId }) => refreshInboxViews(qc, projectId),
  });
}

export function useUpdateEmailInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      connectionId,
      ...patch
    }: {
      projectId: string;
      connectionId: string;
      sender_policy?: EmailSenderPolicy;
      display_name?: string;
      label?: string;
    }) => updateEmailInbox(projectId, connectionId, patch),
    onSuccess: (_inbox, { projectId }) => refreshInboxViews(qc, projectId),
  });
}

export function useRemoveEmailInbox() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, connectionId }: { projectId: string; connectionId: string }) =>
      removeEmailInbox(projectId, connectionId),
    onSuccess: (_result, { projectId }) => refreshInboxViews(qc, projectId),
  });
}
