'use client';

import { useFeatureFlag } from '@kortix/sdk/react';
import { PhoneIcon } from '@phosphor-icons/react';
import { lazy, Suspense, useEffect } from 'react';

import { useTranslations } from '../../i18n';
import { isDesktop } from '../../internal/lib/desktop-detect';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { useVoiceCallStore } from './voice-call-store';

// The call itself (socket, audio, screen share) loads with the first call, never for a project without the flag.
const VoiceCallBar = lazy(() => import('./voice-call-bar').then((m) => ({ default: m.VoiceCallBar })));

/**
 * The session header's Call button: only while the project's `voice_call` flag is on, and not in the desktop
 * shell, whose signed app has no microphone entitlement yet (apps/desktop-electron). It opens and ends the call.
 */
export function VoiceCallButton({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const t = useTranslations('voiceCall');
  const { enabled } = useFeatureFlag(projectId, 'voice_call');
  const open = useVoiceCallStore((s) => s.sessionId === sessionId);
  const toggle = useVoiceCallStore((s) => s.toggle);
  if (!enabled || isDesktop()) return null;
  const label = open ? t('end') : t('start');
  return (
    <Hint side="bottom" sideOffset={4} delayDuration={300} label={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={open}
        onClick={() => toggle(sessionId)}
        className="text-muted-foreground hover:text-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground cursor-pointer transition-colors active:scale-[0.96]"
      >
        <PhoneIcon className="h-4 w-4" />
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
