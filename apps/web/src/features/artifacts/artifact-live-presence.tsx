'use client';

import type { ArtifactLiveParticipant, ArtifactLiveStatus, ArtifactLiveTyping } from '@kortix/sdk';
import { cn } from '@kortix/ui';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { RobotIcon } from '@phosphor-icons/react';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { LIVE_RING } from './artifact-live-colors';
import { agentsAt, createTypingSignal, typingKey, typingNames } from './artifact-live-logic';

/**
 * Live presence for the discussion panel, its threads and its composers. The
 * viewer provides it while the Artifact's live connection is on; without a
 * provider every live element renders nothing and sends nothing.
 */
export interface ArtifactLiveContextValue {
  participants: readonly ArtifactLiveParticipant[];
  you: string | null;
  viewerId: string | null;
  setTyping: (where: ArtifactLiveTyping, active: boolean) => void;
}

export const ArtifactLiveContext = createContext<ArtifactLiveContextValue | null>(null);

export const useArtifactLiveContext = () => useContext(ArtifactLiveContext);

/** The words of an agent's status. People are always "viewing". */
export function useLiveStatusLabel() {
  const t = useTranslations('artifacts.live');
  return (status: ArtifactLiveStatus) => t(`status.${status}`);
}

/**
 * The typing signal of one composer: `input()` on each edit, `stop()` on blur
 * or send. It stops by itself after 2 s without an edit, on unmount, and when
 * the place changes. A null place, or no live connection, sends nothing.
 */
export function useLiveTyping(where: ArtifactLiveTyping | null) {
  const setTyping = useArtifactLiveContext()?.setTyping;
  const latest = useRef({ where, setTyping });
  useEffect(() => {
    latest.current = { where, setTyping };
  });
  // One signal per place, made at the first keystroke there.
  const current = useRef<{ key: string; signal: ReturnType<typeof createTypingSignal> } | null>(
    null,
  );
  const key = where === null ? null : typingKey(where);
  useEffect(
    () => () => {
      current.current?.signal.stop();
      current.current = null;
    },
    [key],
  );
  return useMemo(
    () => ({
      input: () => {
        const place = latest.current.where;
        if (place === null) return;
        const placeKey = typingKey(place);
        if (current.current?.key !== placeKey) {
          current.current?.signal.stop();
          current.current = {
            key: placeKey,
            signal: createTypingSignal((active) => latest.current.setTyping?.(place, active)),
          };
        }
        current.current.signal.input();
      },
      stop: () => current.current?.signal.stop(),
    }),
    [],
  );
}

/**
 * "Ana is typing…" for one place (a thread's reply box, or the new-comment
 * composer), one name per person. The visible line comes and goes; the
 * `aria-live` region stays mounted so a screen reader hears each change.
 */
export function LiveTypingLine({
  where,
  agents = [],
  className,
}: {
  where: ArtifactLiveTyping;
  /** Agents writing here: "Kortix is writing…". */
  agents?: readonly string[];
  className?: string;
}) {
  const t = useTranslations('artifacts.live');
  const live = useArtifactLiveContext();
  const names = live ? typingNames(live.participants, live.you, live.viewerId, where) : [];
  const lines = [
    ...agents.map((name) => t('writing', { name })),
    ...(names.length === 0
      ? []
      : names.length === 1
        ? [t('typingOne', { name: names[0]! })]
        : names.length === 2
          ? [t('typingTwo', { first: names[0]!, second: names[1]! })]
          : [t('typingMany', { count: names.length })]),
  ];
  const text = lines.join(' ');
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {text}
      </span>
      {text ? (
        <p aria-hidden className={cn('text-muted-foreground text-xs', className)}>
          {text}
        </p>
      ) : null}
    </>
  );
}

/**
 * Who works in one thread, live: each agent whose place is the thread (its
 * glyph in its color ring, its name, and "Reading" or "Editing"), then the
 * "is writing…" and "is typing…" line. Nothing while nobody is there.
 */
export function ArtifactThreadPresence({ threadId }: { threadId: string }) {
  const live = useArtifactLiveContext();
  const statusLabel = useLiveStatusLabel();
  const t = useTranslations('artifacts.live');
  if (!live) return null;
  const agents = agentsAt(live.participants, threadId);
  const placed = agents.filter((agent) => agent.status !== 'writing');
  const writing = agents.filter((agent) => agent.status === 'writing').map((agent) => agent.name);
  return (
    <>
      {placed.length ? (
        <ul aria-label={t('agentsHere')} className="flex flex-wrap gap-x-3 gap-y-1">
          {placed.map((agent) => (
            <li
              key={agent.key}
              data-live-agent={agent.key}
              className="text-foreground flex min-w-0 items-center gap-1.5 text-xs"
            >
              <EntityAvatar
                icon={RobotIcon}
                label={agent.name}
                size="xs"
                className={cn('ring-offset-background ring-2 ring-offset-1', LIVE_RING[agent.color])}
              />
              <span className="min-w-0 truncate font-medium">{agent.name}</span>
              <span className="text-muted-foreground shrink-0">{statusLabel(agent.status)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <LiveTypingLine where={{ thread_id: threadId }} agents={writing} />
    </>
  );
}
