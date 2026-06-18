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
      // Managed cloud is paid-only: no active subscription → prompt to subscribe.
      const noPlan =
        isBillingEnabled() && !!accountState && !accountState.subscription?.subscription_id;
      if (noPlan) {
        openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId });
        return;
      }

      setBusy(true);
      try {
        const created = await createProjectSession(projectId, {
          initial_prompt: text,
          ...(options?.sandbox_slug ? { sandbox_slug: options.sandbox_slug } : {}),
        });
        const sessionId = created.session_id;
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        prefetchSessionStart(queryClient, projectId, sessionId);
        router.prefetch(`/projects/${projectId}/sessions/${sessionId}`);
        router.push(`/projects/${projectId}/sessions/${sessionId}`);
      } catch (err) {
        setBusy(false);
        const code = (err as any)?.code;
        if (code === 'concurrent_session_limit') return;
        if (code === 'subscription_required' || code === 'no_account') {
          const blockedAccountId = (err as any)?.detail?.account_id ?? projectAccountId;
          openUpgradeDialog({ reason: code, accountId: blockedAccountId });
          return;
        }
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
