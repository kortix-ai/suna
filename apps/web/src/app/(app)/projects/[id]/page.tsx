'use client';

import { errorToast } from '@/components/ui/toast';
import {
  ProjectHome,
  type ProjectHomeSendOptions,
} from '@/features/co-worker/project-layout/project-home';
import { ProjectShell } from '@/features/co-worker/project-layout/project-shell';
import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import {
  createProjectSession,
  getProjectDetail,
  prefetchSessionStart,
} from '@/lib/projects-client';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const [busy, setBusy] = useState(false);

  const handleSend = useCallback(
    async (text: string, options?: ProjectHomeSendOptions) => {
      if (!text.trim() || busy) return;

      // Fast client-side pre-check (best-effort; backend is authoritative).
      const noPlan =
        isBillingEnabled() && !!accountState && !accountState.subscription?.subscription_id;
      if (noPlan) {
        openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId });
        return;
      }

      setBusy(true);
      try {
        // Create FIRST. If the account has no plan, this 402s and we bail —
        // no navigation, no dead session page. Use the id the SERVER returns
        // (not a client-generated one): with the warm pool, create may hand
        // back a pre-booted sandbox whose id is server-authoritative.
        const created = await createProjectSession(projectId, {
          ...(options?.sandbox_slug ? { sandbox_slug: options.sandbox_slug } : {}),
        });
        const sessionId = created.session_id;
        sessionStorage.setItem(`project_pending_prompt:${sessionId}`, text);
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        // Kick the runtime boot DURING the route transition, not after the
        // session page paints (shared helper keeps the query key in sync with
        // the session page so RQ dedupes instead of double-POSTing). Plus warm
        // the route bundle so navigation is instant.
        prefetchSessionStart(queryClient, projectId, sessionId);
        router.prefetch(`/projects/${projectId}/sessions/${sessionId}`);
        router.push(`/projects/${projectId}/sessions/${sessionId}`);
      } catch (err) {
        setBusy(false);
        const code = (err as any)?.code;
        // 429 concurrent-session-limit is handled globally — skip the toast.
        if (code === 'concurrent_session_limit') return;
        // No plan → open the one Team plan subscribe modal. Don't navigate.
        // Scope to the blocked account from the 402 (the project's owning
        // account), falling back to the project account we already resolved.
        if (code === 'subscription_required' || code === 'no_account') {
          const blockedAccountId = (err as any)?.detail?.account_id ?? projectAccountId;
          openUpgradeDialog({ reason: code, accountId: blockedAccountId });
          return;
        }
        // Out of credits on an existing plan (legacy/balance) → surface the
        // backend message ("Top up to continue"); don't pitch a subscription.
        errorToast(err instanceof Error ? err.message : 'Failed to start session');
      }
    },
    [projectId, projectAccountId, queryClient, router, accountState, openUpgradeDialog, busy],
  );

  return (
    <ProjectShell projectId={projectId}>
      <ProjectHome projectId={projectId} onSend={handleSend} busy={busy} />
    </ProjectShell>
  );
}
