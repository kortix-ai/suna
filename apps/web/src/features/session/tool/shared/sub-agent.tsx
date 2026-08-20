'use client';

import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { ToolSurfaceContext, useToolIndent } from '@/features/session/tool/shared/surface';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import { cn } from '@/lib/utils';
import type { MessageWithParts, ToolPart } from '@/ui';
import { getChildSessionError, getRetryInfo, getRetryMessage } from '@/ui';
import { useSessionStateStore } from '@kortix/sdk/react';
import { useEffect, useMemo, useState } from 'react';

/**
 * A sub-agent's steps, listed under the row that dispatched it.
 *
 * The list takes the tool indent, and that is the whole point of this wrapper.
 * Every other payload in the chat — a code card, a diff, a search result —
 * already clears the leading-icon gutter through {@link useToolIndent}; this
 * list was the one that did not, and it rendered flush at the margin. Two
 * things broke, both visible the moment a sub-agent ran:
 *
 *  - `ChainOfThoughtStep` runs its hairline down the CENTRE of that gutter
 *    (`left-2`, i.e. 8px). Child rows starting at 0 put their own 16px glyphs
 *    across 0–16px, so the rail struck straight through every one of them.
 *  - A child row sat at the exact x of the parent `Agent · …` row, at the same
 *    type scale, so the sub-agent's work read as SIBLINGS of the agent in the
 *    turn's chain rather than as work belonging to it. The hierarchy the row
 *    exists to express was not drawn at all.
 *
 * Indenting to the parent's TEXT column fixes both at once: the rail gets the
 * empty lane it was designed for, and the rows line up under the words that
 * name the agent, which is what says they are its.
 *
 * The indent is read BEFORE the provider below flips the surface to `inline`.
 * The offset a nested list needs belongs to the row it hangs under, and that
 * row's surface is the outer one — on the panel there is no icon gutter and no
 * rail, so `useToolIndent` correctly returns nothing there.
 */
export function SubAgentActivity({
  childSessionId,
  parts,
}: {
  childSessionId?: string;
  parts: ToolPart[];
}) {
  const indent = useToolIndent();

  if (parts.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <div className={cn('space-y-1', indent)}>
        {parts.map((tp) => (
          <ToolPartRenderer
            key={tp.callID}
            part={tp}
            sessionId={childSessionId}
            disableNavigation
          />
        ))}
      </div>
    </ToolSurfaceContext.Provider>
  );
}

export function SubAgentStatusBanner({
  childSessionId,
  childMessages,
}: {
  childSessionId?: string;
  childMessages?: MessageWithParts[];
}) {
  const childStatus = useSessionStateStore((s) =>
    childSessionId ? s.sessionStatus[childSessionId] : undefined,
  );
  const retryInfo = useMemo(() => getRetryInfo(childStatus), [childStatus]);
  const retryMessage = useMemo(() => getRetryMessage(childStatus), [childStatus]);
  const childError = useMemo(() => getChildSessionError(childMessages), [childMessages]);

  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setSecondsLeft(0);
      return;
    }
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryInfo]);

  if (retryInfo && retryMessage) {
    return (
      <SessionRetryDisplay
        message={retryMessage}
        attempt={retryInfo.attempt}
        secondsLeft={secondsLeft}
        details={retryInfo.details}
        className="mt-2"
      />
    );
  }

  if (childError) {
    return <TurnErrorDisplay errorText={childError} className="mt-2" />;
  }

  return null;
}
