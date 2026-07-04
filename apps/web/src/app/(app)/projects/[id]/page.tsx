'use client';

import { buildNewSessionCreateInput } from '@/features/workspace/project-layout/new-session-create';
import {
  ProjectHome,
  type ProjectHomeSendOptions,
} from '@/features/workspace/project-layout/project-home';
import { ProjectShell } from '@/features/workspace/project-layout/project-shell';
import type { AttachedFile } from '@/features/session/session-chat-input';
import { useAccountState } from '@/hooks/billing';
import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useProjectCanRun } from '@/hooks/projects/use-project-can-run';
import { isBillingEnabled } from '@/lib/config';
import { getProjectDetail } from '@kortix/sdk/projects-client';
import { writeStartStash } from '@kortix/sdk/react';
import { usePendingFilesStore } from '@/stores/pending-files-store';
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
    (text: string, files: AttachedFile[] | undefined, options?: ProjectHomeSendOptions) => {
      if (!text.trim() && !files?.length) return;

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
      // Bind the chosen agent at session birth so it matches the `agent` the
      // composer sends on the first prompt — sessions are agent-immutable and the
      // API proxy 409s any prompt whose agent differs from the bound one, which
      // defaults to "default" when unset (see buildNewSessionCreateInput).
      newSession({
        create: buildNewSessionCreateInput(options),
        onNavigate: (sessionId) => {
          // `sessionId` here is the route/Kortix session id, not the OpenCode
          // pin the session page resolves later (`useCanonicalOpenCodeSession`
          // /`ensureOpencodeSessionPin` mint a separate id). Stash under the
          // route id via the SDK's canonical `writeStartStash` — the session
          // page's `migrateStash` hands this off onto the resolved pin once it
          // exists, and `readStartStash` (instant shell, `useSession`) reads it
          // uniformly either side of that migration.
          writeStartStash(sessionId, {
            prompt: text,
            agent: options?.agent ?? null,
            model: options?.model ?? null,
            variant: options?.variant ?? null,
          });
          if (files?.length) {
            usePendingFilesStore.getState().setPendingFiles(files);
          }
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
