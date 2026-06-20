'use client';

import {
  ProjectHome,
  type ProjectHomeSendOptions,
} from '@/features/co-worker/project-layout/project-home';
import { ProjectShell } from '@/features/co-worker/project-layout/project-shell';
import { useAccountState } from '@/hooks/billing';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { isBillingEnabled } from '@/lib/config';
import { getProjectDetail } from '@/lib/projects-client';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback } from 'react';

export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const newSession = useNewProjectSession(projectId);

  const handleSend = useCallback(
    (text: string, options?: ProjectHomeSendOptions) => {
      if (!text.trim()) return;

      // Gate no-plan accounts before navigating so we never strand the user on a
      // shell that can't provision — pitch the upgrade in place instead.
      const noPlan =
        isBillingEnabled() && !!accountState && !accountState.subscription?.subscription_id;
      if (noPlan) {
        openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId });
        return;
      }

      // Identical optimistic path to every other new-session entry point: mint the
      // id, paint the instant shell, and let the session page auto-send `text` once
      // the box is ready. No server-side initial_prompt — the shell shows the
      // message + inline boot status, matching the global dashboard composer.
      newSession({
        create: options?.sandbox_slug ? { sandbox_slug: options.sandbox_slug } : undefined,
        onNavigate: (sessionId) => {
          sessionStorage.setItem(`project_pending_prompt:${sessionId}`, text);
        },
      });
    },
    [accountState, projectAccountId, openUpgradeDialog, newSession],
  );

  return (
    <ProjectShell projectId={projectId}>
      <ProjectHome projectId={projectId} onSend={handleSend} busy={false} />
    </ProjectShell>
  );
}
