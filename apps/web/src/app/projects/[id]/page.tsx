'use client';

import { useCallback, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { ProjectShell } from '@/components/projects/project-shell';
import { ProjectHome, type ProjectHomeSendOptions } from '@/components/projects/project-home';
import { createProjectSession } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { useAccountState } from '@/hooks/billing';
import { useUpgradeDialogStore } from '@/stores/upgrade-dialog-store';
import { isBillingEnabled } from '@/lib/config';

/**
 * Project root — the project home / dashboard.
 *
 * A welcome hero + a composer to start a session, over a grid of section tiles
 * (integrations, scheduled tasks, skills, Slack, team, agent) that tease the
 * feature and prompt setup, each docs-backed.
 *
 * Send flow: create the session FIRST, then navigate on success. We used to
 * navigate optimistically (mint id → push → POST in background) for perceived
 * speed, but that meant a no-plan account got dropped onto a dead session page
 * before the billing 402 came back. Now the backend's billing gate (which knows
 * THIS project's account) is authoritative: a 402 opens the Team plan modal and
 * we never navigate. The session id is client-minted so we can stash the pending
 * prompt; the API accepts client-provided ids via the `session_id` body field.
 */
export default function ProjectIndexPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: accountState } = useAccountState();
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);

  const [busy, setBusy] = useState(false);

  const handleSend = useCallback(
    async (text: string, options?: ProjectHomeSendOptions) => {
      if (!text.trim() || busy) return;

      // Fast client-side pre-check (best-effort; backend is authoritative).
      const noPlan =
        isBillingEnabled() &&
        !!accountState &&
        !accountState.subscription?.subscription_id;
      if (noPlan) {
        openUpgradeDialog({ reason: 'subscription_required' });
        return;
      }

      setBusy(true);
      const sessionId = crypto.randomUUID();
      try {
        // Create FIRST. If the account has no plan, this 402s and we bail —
        // no navigation, no dead session page.
        await createProjectSession(projectId, {
          session_id: sessionId,
          ...(options?.sandbox_slug ? { sandbox_slug: options.sandbox_slug } : {}),
        });
        sessionStorage.setItem(`project_pending_prompt:${sessionId}`, text);
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        router.push(`/projects/${projectId}/sessions/${sessionId}`);
      } catch (err) {
        setBusy(false);
        const code = (err as any)?.code;
        // 429 concurrent-session-limit is handled globally — skip the toast.
        if (code === 'concurrent_session_limit') return;
        // No plan → open the one Team plan subscribe modal. Don't navigate.
        if (code === 'subscription_required' || code === 'no_account') {
          openUpgradeDialog({ reason: code });
          return;
        }
        // Out of credits on an existing plan (legacy/balance) → surface the
        // backend message ("Top up to continue"); don't pitch a subscription.
        toast.error(err instanceof Error ? err.message : 'Failed to start session');
      }
    },
    [projectId, queryClient, router, accountState, openUpgradeDialog, busy],
  );

  return (
    <ProjectShell projectId={projectId}>
      <ProjectHome projectId={projectId} onSend={handleSend} busy={busy} />
    </ProjectShell>
  );
}
