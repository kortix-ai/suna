'use client';

import { createProjectSession, markSessionFresh, platformConfig } from '@kortix/sdk';
import { qk, upsertCachedProjectSession, useFeatureFlag } from '@kortix/sdk/react';
import { PhoneIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';

import { useTranslations } from '../../i18n';
import { useProjectCanRun } from '../../internal/hooks/projects/use-project-can-run';
import { isDesktop } from '../../internal/lib/desktop-detect';
import { useUpgradeDialogStore } from '../../internal/stores/upgrade-dialog-store';
import { randomUUID } from '../../internal/lib/utils/random-uuid';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { errorToast } from '../../primitives/toast';
import { useVoiceCallStore } from './voice-call-store';

/**
 * The agent page's Call button (Customize → Agents → <agent>). A call is a session of its own on this agent: the
 * agent answers with its own instructions, tools and memory, and the call's transcript is that session's chat. The
 * page stays: the session is created here, with no navigation and no toast, and the call card (voice-call-card.tsx)
 * rings until its box answers. Only while the project's `voice_call` flag is on, and not in the desktop shell, whose
 * signed app has no microphone entitlement yet (apps/desktop-electron).
 */
export function AgentCallButton({ projectId, agentName }: { projectId: string; agentName: string }) {
  const t = useTranslations('voiceCall');
  const { enabled } = useFeatureFlag(projectId, 'voice_call');
  const { canRun, isLoading: billingLoading, accountId } = useProjectCanRun(projectId);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const inCall = useVoiceCallStore((s) => !!s.call);
  const queryClient = useQueryClient();
  if (!enabled || isDesktop()) return null;
  const call = async () => {
    // The same gate as Start session: no session the account cannot run.
    if (platformConfig().billingEnabled && !billingLoading && !canRun) return void openUpgradeDialog({ reason: 'subscription_required', accountId });
    const sessionId = randomUUID();
    markSessionFresh(sessionId);
    useVoiceCallStore.getState().place({ projectId, sessionId, agent: agentName });
    try {
      const created = await createProjectSession(projectId, { session_id: sessionId, agent_name: agentName });
      if (created?.project_id === projectId) upsertCachedProjectSession(queryClient, projectId, created);
      void queryClient.invalidateQueries({ queryKey: qk.project.sessionsScope(projectId) });
    } catch {
      useVoiceCallStore.getState().end(sessionId);
      errorToast(t('failed'));
    }
  };
  return (
    <Hint side="bottom" sideOffset={4} delayDuration={300} label={t('start')}>
      <Button variant="secondary" size="sm" aria-label={t('start')} disabled={inCall} onClick={() => void call()}>
        <PhoneIcon weight="fill" className="size-3.5 shrink-0" />
        <span className="hidden sm:inline">{t('call')}</span>
      </Button>
    </Hint>
  );
}
