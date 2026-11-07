'use client';

import { startProjectSession } from '@kortix/sdk';
import {
  ChatCircleIcon,
  MicrophoneIcon,
  MicrophoneSlashIcon,
  PhoneDisconnectIcon,
  PhoneIcon,
  ScreencastIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMark, agentDisplayName } from '../../internal/components/agent-mark';
import { isDesktop } from '../../internal/lib/desktop-detect';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { SessionDotMatrix } from '../../primitives/dot-matrix/session-dot-matrix';
import Hint from '../../primitives/hint';
import { useUiRouter } from '../../providers/ui-provider';
import { callTime, ringback } from './call-ring';
import { useVoiceCall } from './use-voice-call';
import { INITIAL_CALL, type CallEnd, type CallLine, type CallState } from './voice-call-state';
import { useVoiceCallStore, type ActiveCall } from './voice-call-store';

const ENDED: Record<CallEnd, { key: string; dot: string | null }> = {
  closed: { key: 'ended', dot: null },
  unavailable: { key: 'unavailable', dot: 'bg-kortix-orange' },
  failed: { key: 'failed', dot: 'bg-kortix-red' },
  lost: { key: 'lost', dot: 'bg-kortix-red' },
};

/**
 * The call in progress, as a phone shows one: the agent's mark and name, "Calling…" with a ringback while its box
 * starts, then the call's length, its last line, and mute, share screen, open the chat and hang up. In the project
 * shell, so the call goes on wherever the person goes in the project; nothing without a call.
 */
export function VoiceCallCard() {
  const call = useVoiceCallStore((s) => s.call);
  if (!call || isDesktop()) return null;
  return <PlacedCall key={call.sessionId} call={call} />;
}

/** The box a placed call rings: its session's sandbox, once /start says it is ready (its external id). */
function useCallBox(call: ActiveCall): { sandboxId?: string; failed?: boolean } {
  const [box, setBox] = useState<{ sandboxId?: string; failed?: boolean }>({});
  useEffect(() => {
    let stopped = false;
    void (async () => {
      // Each /start long-polls up to 25 s; a fresh session's first ones may find no row yet (null): asked again.
      for (let i = 0; i < 24 && !stopped; i++) {
        const started = await startProjectSession(call.projectId, call.sessionId, 25_000).catch(() => undefined);
        if (stopped) return;
        const sandboxId = started?.stage === 'ready' ? started.sandbox?.external_id : undefined;
        if (sandboxId) return void setBox({ sandboxId });
        if (started && started.stage === 'failed' && !started.retriable) return void setBox({ failed: true });
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!stopped) setBox({ failed: true });
    })();
    return () => {
      stopped = true;
    };
  }, [call.projectId, call.sessionId]);
  return box;
}

function PlacedCall({ call }: { call: ActiveCall }) {
  const box = useCallBox(call);
  // The ringback from the click until the call is answered (live) or over.
  const [answered, setAnswered] = useState(false);
  const [over, setOver] = useState(false);
  const onPhase = useCallback((phase: CallState['phase']) => {
    setAnswered(phase === 'live' || phase === 'reconnecting');
    setOver(phase === 'ended');
  }, []);
  useEffect(() => {
    if (answered || over || box.failed) return;
    return ringback();
  }, [answered, over, box.failed]);
  if (box.failed) return <CardFailed call={call} />;
  if (!box.sandboxId) return <Card call={call} status="calling" />;
  return <LiveCall call={call} sandboxId={box.sandboxId} onPhase={onPhase} />;
}

function LiveCall({ call, sandboxId, onPhase }: { call: ActiveCall; sandboxId: string; onPhase: (phase: CallState['phase']) => void }) {
  const { state, muted, toggleMute, sharing, canShare, toggleShare, callAgain } = useVoiceCall(call.sessionId, sandboxId);
  // Ringing until answered, again on a redial ("Call again"), whose length counts anew (state.liveAt).
  useEffect(() => onPhase(state.phase), [state.phase, onPhase]);
  return (
    <Card
      call={call}
      status={state.phase === 'live' ? (state.speaking ? 'speaking' : 'listening') : state.phase}
      state={state}
      liveAt={state.liveAt}
      controls={{ muted, toggleMute, sharing, canShare, toggleShare, callAgain }}
    />
  );
}

function CardFailed({ call }: { call: ActiveCall }) {
  return <Card call={call} status="ended" state={{ ...INITIAL_CALL, phase: 'ended', end: 'failed' }} />;
}

function Card({
  call,
  status,
  state,
  liveAt,
  controls,
}: {
  call: ActiveCall;
  status: 'calling' | 'connecting' | 'listening' | 'speaking' | 'reconnecting' | 'ended';
  state?: CallState;
  liveAt?: number | null;
  controls?: { muted: boolean; toggleMute: () => void; sharing: boolean; canShare: boolean; toggleShare: () => Promise<void>; callAgain: () => void };
}) {
  const t = useTranslations('voiceCall');
  const router = useUiRouter();
  const end = useVoiceCallStore((s) => s.end);
  const hangUp = () => end(call.sessionId);
  const openChat = () => router.push(uiRoutes().session(call.projectId, call.sessionId));
  const name = agentDisplayName(call.agent);
  // The call's length, ticking while it is live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!liveAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [liveAt]);
  const ended = state?.phase === 'ended' && state.end ? ENDED[state.end] : undefined;
  const line: CallLine | null | undefined = state?.line;
  return (
    <section
      aria-label={t('title')}
      className="kx-fade-up bg-background border-border fixed right-4 bottom-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border p-3 shadow-lg"
    >
      <div className="flex items-center gap-3">
        {/* The agent leans in while it speaks: a small lift, no motion for those who ask for none. */}
        <span className={cn('shrink-0 transition-transform duration-300 ease-out motion-reduce:transition-none', status === 'speaking' && 'scale-105')}>
          <AgentMark slug={call.agent} size={42} label={name} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-medium">{name}</p>
          <p role="status" className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
            {ended ? (
              <>
                {ended.dot && <span aria-hidden className={cn('size-2 shrink-0 rounded-full', ended.dot)} />}
                {t(ended.key)}
              </>
            ) : status === 'calling' || status === 'connecting' ? (
              <>
                {/* The session's own busy mark (the sidebar's, for this session): its box is starting. */}
                <SessionDotMatrix sessionId={call.sessionId} size={14} className="shrink-0" />
                {t('calling')}
              </>
            ) : (
              <>
                {status !== 'reconnecting' && <span aria-hidden className="bg-kortix-green size-2 shrink-0 rounded-full" />}
                {liveAt ? <span className="tabular-nums">{callTime(now - liveAt)}</span> : null}
                {liveAt ? <span aria-hidden>·</span> : null}
                {t(status)}
              </>
            )}
          </p>
        </div>
      </div>
      {!ended && (state?.micBlocked || line) ? (
        <p className="text-foreground line-clamp-2 text-sm">
          {state?.micBlocked ? (
            <span className="text-muted-foreground">{t('noMicrophone')}</span>
          ) : (
            line && (
              <>
                <span className="text-muted-foreground">{line.role === 'agent' ? line.who : t('you')}</span> {line.text}
              </>
            )
          )}
        </p>
      ) : null}
      <div className="flex items-center gap-1">
        {ended ? (
          <>
            {state?.end !== 'unavailable' && controls && (
              <Button variant="secondary" size="sm" onClick={controls.callAgain}>
                <PhoneIcon weight="fill" className="size-3.5" />
                {t('callAgain')}
              </Button>
            )}
            <CardButton label={t('openChat')} onClick={openChat}>
              <ChatCircleIcon className="size-4" />
            </CardButton>
            <span className="flex-1" />
            <CardButton label={t('close')} onClick={hangUp}>
              <XIcon className="size-4" />
            </CardButton>
          </>
        ) : (
          <>
            <CardButton label={controls?.muted ? t('unmute') : t('mute')} pressed={controls?.muted} disabled={!controls || state?.micBlocked} onClick={() => controls?.toggleMute()}>
              {controls?.muted || state?.micBlocked ? <MicrophoneSlashIcon className="size-4" /> : <MicrophoneIcon className="size-4" />}
            </CardButton>
            {controls?.canShare !== false && (
              <CardButton
                label={controls?.sharing ? t('stopSharing') : t('shareScreen')}
                pressed={controls?.sharing}
                disabled={!controls || (status !== 'listening' && status !== 'speaking' && !controls.sharing)}
                onClick={() => void controls?.toggleShare()}
              >
                <ScreencastIcon className="size-4" />
              </CardButton>
            )}
            <CardButton label={t('openChat')} onClick={openChat}>
              <ChatCircleIcon className="size-4" />
            </CardButton>
            <span className="flex-1" />
            <Hint side="top" sideOffset={4} delayDuration={300} label={t('end')}>
              <Button size="icon" aria-label={t('end')} onClick={hangUp} className="bg-kortix-red hover:bg-kortix-red/90 rounded-full text-white">
                <PhoneDisconnectIcon weight="fill" className="size-4" />
              </Button>
            </Hint>
          </>
        )}
      </div>
    </section>
  );
}

function CardButton({ label, pressed, disabled, onClick, children }: { label: string; pressed?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Hint side="top" sideOffset={4} delayDuration={300} label={label}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className="text-muted-foreground hover:text-foreground aria-pressed:bg-foreground/10 aria-pressed:text-foreground transition-colors active:scale-[0.96]"
      >
        {children}
      </Button>
    </Hint>
  );
}
