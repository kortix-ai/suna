'use client';

import {
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
  ScreencastIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import Hint from '../../primitives/hint';
import Loading from '../../primitives/loading';
import { useVoiceCall } from './use-voice-call';
import type { CallEnd } from './voice-call-state';
import { useVoiceCallStore } from './voice-call-store';

// The queued messages' card chrome: the call is one more card in the stack above the composer.
const BAR = 'bg-background border-border flex w-full items-center gap-2 rounded-lg border p-1 pl-3 not-last:mb-2';
const TOGGLE =
  'text-muted-foreground hover:text-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground transition-colors active:scale-[0.96]';

const ENDED: Record<CallEnd, { key: string; dot: string | null }> = {
  closed: { key: 'ended', dot: null },
  unavailable: { key: 'unavailable', dot: 'bg-kortix-orange' },
  failed: { key: 'failed', dot: 'bg-kortix-red' },
  lost: { key: 'lost', dot: 'bg-kortix-red' },
};

/** A live voice call with this session, as one card above its composer. */
export function VoiceCallBar({ sessionId }: { sessionId: string }) {
  const t = useTranslations('voiceCall');
  const close = useVoiceCallStore((s) => s.close);
  const { state, muted, toggleMute, sharing, canShare, toggleShare, callAgain } = useVoiceCall(sessionId);
  const hangUp = () => close(sessionId);

  if (state.phase === 'ended' && state.end) {
    const { key, dot } = ENDED[state.end];
    return (
      <section aria-label={t('title')} className={BAR}>
        {dot && <span aria-hidden className={cn('size-2 shrink-0 rounded-full', dot)} />}
        <p role="status" className="text-muted-foreground min-w-0 flex-1 text-sm text-pretty">
          {t(key)}
        </p>
        <ButtonGroup className="shrink-0">
          {state.end !== 'unavailable' && (
            <Button variant="ghost" size="xs" onClick={callAgain}>
              <PhoneIcon className="size-3.5" />
              {t('callAgain')}
            </Button>
          )}
          <BarButton label={t('close')} onClick={hangUp}>
            <XIcon className="size-3.5" />
          </BarButton>
        </ButtonGroup>
      </section>
    );
  }

  const live = state.phase === 'live';
  const status = live ? (state.speaking ? 'speaking' : 'listening') : state.phase;
  const muteLabel = muted ? t('unmute') : t('mute');
  const shareLabel = sharing ? t('stopSharing') : t('shareScreen');
  return (
    <section aria-label={t('title')} className={BAR}>
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
        {live ? (
          <span aria-hidden className="bg-kortix-green size-2 shrink-0 rounded-full" />
        ) : (
          <Loading className="size-3.5 shrink-0" />
        )}
        {t(status)}
      </span>
      <p className="text-foreground min-w-0 flex-1 truncate text-sm">
        {state.micBlocked ? (
          <span className="text-muted-foreground">{t('noMicrophone')}</span>
        ) : (
          state.line && (
            <>
              <span className="text-muted-foreground">{state.line.role === 'agent' ? state.line.who : t('you')}</span>{' '}
              {state.line.text}
            </>
          )
        )}
      </p>
      <ButtonGroup className="shrink-0">
        <BarButton label={muteLabel} pressed={muted} disabled={state.micBlocked} onClick={toggleMute}>
          {muted || state.micBlocked ? <MicrophoneSlashIcon className="size-3.5" /> : <MicrophoneIcon className="size-3.5" />}
        </BarButton>
        {canShare && (
          <BarButton label={shareLabel} pressed={sharing} disabled={!live && !sharing} onClick={() => void toggleShare()}>
            <ScreencastIcon className="size-3.5" />
          </BarButton>
        )}
        <BarButton label={t('end')} onClick={hangUp}>
          <PhoneDisconnectIcon className="size-3.5" />
        </BarButton>
      </ButtonGroup>
    </section>
  );
}

function BarButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Hint side="top" sideOffset={4} delayDuration={300} label={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={TOGGLE}
      >
        {children}
      </Button>
    </Hint>
  );
}
