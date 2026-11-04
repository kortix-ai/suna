'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { PhoneIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useEffect } from 'react';

import { useTranslations } from '../../i18n';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import { isDesktop } from '../../internal/lib/desktop-detect';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { useVoiceCallStore } from './voice-call-store';

// The call itself (socket, audio, screen share) loads with the first call, never for a project without the flag.
const VoiceCallBar = lazy(() => import('./voice-call-bar').then((m) => ({ default: m.VoiceCallBar })));

/**
 * The agent page's Call button (Customize → Agents → <agent>). A call is a session of its own on this agent: the
 * agent answers with its own instructions, tools and memory, and the call's transcript is that session's chat, never
 * mixed into one already open. It starts the session the way Start session does and opens the call for it, so the
 * session page dials as soon as its box is up. Only while the project's `voice_call` flag is on, and not in the
 * desktop shell, whose signed app has no microphone entitlement yet (apps/desktop-electron).
 */
export function AgentCallButton({ projectId, agentName }: { projectId: string; agentName: string }) {
  const t = useTranslations('voiceCall');
  const { enabled } = useFeatureFlag(projectId, 'voice_call');
  const startSession = useNewProjectSession(projectId);
  if (!enabled || isDesktop()) return null;
  const call = () => {
    let placed: string | undefined;
    startSession({
      create: { agent_name: agentName },
      onCreating: (sessionId) => {
        placed = sessionId;
        useVoiceCallStore.getState().open(sessionId);
      },
      onError: () => {
        if (placed) useVoiceCallStore.getState().close(placed);
      },
    });
  };
  return (
    <Hint side="bottom" sideOffset={4} delayDuration={300} label={t('start')}>
      <Button variant="secondary" size="sm" aria-label={t('start')} onClick={call}>
        <PhoneIcon weight="fill" className="size-3.5 shrink-0" />
        <span className="hidden sm:inline">{t('call')}</span>
      </Button>
    </Hint>
  );
}

/** Where the call bar sits above the composer: nothing unless this session's call is open. */
export function VoiceCallSlot({ sessionId }: { sessionId: string | undefined }) {
  const open = useVoiceCallStore((s) => !!sessionId && s.sessionId === sessionId);
  // A call lasts while its session is on screen: leaving the session ends it, so coming back never redials.
  useEffect(
    () => () => {
      if (sessionId) useVoiceCallStore.getState().close(sessionId);
    },
    [sessionId],
  );
  if (!open || !sessionId) return null;
  return (
    <Suspense fallback={null}>
      <VoiceCallBar sessionId={sessionId} />
    </Suspense>
  );
}
