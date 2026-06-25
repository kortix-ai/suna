'use client';

import {
  ProjectHome,
  type ProjectHomeSendOptions,
} from '@/features/co-worker/project-layout/project-home';
import { ProjectShell } from '@/features/co-worker/project-layout/project-shell';
import { useAccountState } from '@/hooks/billing';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import { isBillingEnabled } from '@/lib/config';
import { getProjectDetail } from '@/lib/projects-client';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useCallback, useEffect } from 'react';

const FREE_ONBOARDING_UPGRADE_MODAL_KEY = 'kortix:free-onboarding-upgrade-modal-shown';

export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
  });
  const projectAccountId = projectDetail?.project?.account_id ?? undefined;
  const { canRun, isLoading: billingLoading } = useProjectCanRun(projectId);
  const { data: accountState } = useAccountState({ accountId: projectAccountId });
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const newSession = useNewProjectSession(projectId);

  useEffect(() => {
    if (!isBillingEnabled() || !accountState || !projectAccountId) return;

    const tierKey = (
      accountState.subscription?.tier_key ||
      accountState.tier?.name ||
      ''
    ).toLowerCase();
    const hasActiveSubscription = !!accountState.subscription?.subscription_id;
    const shouldShow = (tierKey === 'free' || tierKey === 'none') && !hasActiveSubscription;
    if (!shouldShow) return;

    const storageKey = `${FREE_ONBOARDING_UPGRADE_MODAL_KEY}:${projectAccountId}`;
    if (window.localStorage.getItem(storageKey) === '1') return;

    window.localStorage.setItem(storageKey, '1');
    openUpgradeDialog({ reason: 'subscription_required', accountId: projectAccountId });
  }, [accountState, projectAccountId, openUpgradeDialog]);

  const handleSend = useCallback(
    (text: string, options?: ProjectHomeSendOptions) => {
      if (!text.trim()) return;

      if (isBillingEnabled() && billingLoading) return;

      // Gate accounts that cannot run before navigating so we never strand the
      // user on a shell that cannot provision. Free accounts with the monthly
      // sandbox grant are allowed through because `can_run` is true.
      const noPlan = isBillingEnabled() && !billingLoading && !canRun;
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
    [billingLoading, canRun, projectAccountId, openUpgradeDialog, newSession],
  );

  return (
    <ProjectShell projectId={projectId}>
      <ProjectHome projectId={projectId} onSend={handleSend} busy={false} />
    </ProjectShell>
  );
}
