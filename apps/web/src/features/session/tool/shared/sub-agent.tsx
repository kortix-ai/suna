'use client';

import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { ToolSurfaceContext, useToolIndent } from '@/features/session/tool/shared/surface';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import { cn } from '@/lib/utils';
import { getRetryInfo, getRetryMessage, shouldShowToolPart } from '@/ui';
import { classifySessionLogMessage, type SessionLogThread, type ToolCallBlock } from '@kortix/sdk';
import { canQueryRuntimeSession, useSessionLogThread, useSessionStateStore } from '@kortix/sdk/react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

const NO_SESSION = { projectId: '', sessionId: '', runtimeSessionId: null };

/**
 * A sub-agent's thread: `useSessionLogThread` of the session on screen (the route's project
 * and session; none on a debug page), by the child's runtime session id. On v2 the API's
 * session log holds it; on v1 it is the `fromV1` view of the child's rows. Holds the child's
 * rows while the row is mounted, as a session view does: the store frees a session once its
 * last consumer is gone, and a preview has no re-hydrate path of its own.
 */
export function useSubAgentThread(childSessionId: string | undefined): SessionLogThread | null {
  const params = useParams<{ id?: string; sessionId?: string }>();
  useEffect(() => {
    if (!canQueryRuntimeSession(childSessionId)) return;
    return useSessionStateStore.getState().retainSession(childSessionId);
  }, [childSessionId]);
  const source = useMemo(
    () => (childSessionId ? { projectId: params?.id ?? '', sessionId: params?.sessionId ?? '', runtimeSessionId: null } : NO_SESSION),
    [childSessionId, params?.id, params?.sessionId],
  );
  return useSessionLogThread(source, childSessionId ?? null);
}

/** The sub-agent's tool calls a row lists: every shown call of its replies, in order. */
export function subAgentCalls(thread: SessionLogThread | null): ToolCallBlock[] {
  if (!thread) return [];
  return thread.messages.flatMap((m) =>
    m.role === 'assistant' ? m.blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call' && shouldShowToolPart(b)) : [],
  );
}

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
 *
 * The list draws NO rail of its own, and that is deliberate. A rail's lane is
 * the icon column of the row it hangs from — that is what `left-2` means in
 * `ChainOfThoughtStep`: the centre of a 16px glyph. A hairline down the left of
 * THIS container would sit in the content lane instead, anchored to nothing,
 * and with a single sub-agent it drew a second bar 20px inside a chain rail
 * that already said the same thing.
 *
 * The line that binds these steps to their agent is therefore drawn by the
 * chain, in the agent row's own icon lane. With one agent that is the burst's
 * own `ChainOfThoughtStep`. With several — `groupSteps` folds them into one
 * "Worked with N helper agents" row — it is the per-member `ChainOfThoughtStep`
 * that `ActivityGroupStep` wraps each agent in. Same component, same mark, one
 * bar per level of nesting that actually exists.
 */
export function SubAgentActivity({
  childSessionId,
  calls,
}: {
  childSessionId?: string;
  calls: ToolCallBlock[];
}) {
  const indent = useToolIndent();

  if (calls.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <div className={cn('space-y-1', indent)}>
        {calls.map((call) => (
          <ToolPartRenderer
            key={call.call_id}
            call={call}
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
  childThread,
}: {
  childSessionId?: string;
  childThread: SessionLogThread | null;
}) {
  const childStatus = useSessionStateStore((s) =>
    childSessionId ? s.sessionStatus[childSessionId] : undefined,
  );
  const retryInfo = useMemo(() => getRetryInfo(childStatus), [childStatus]);
  const retryMessage = useMemo(() => getRetryMessage(childStatus), [childStatus]);
  // The newest reply's error, as the transcript words a turn error.
  const childError = useMemo(() => {
    const failed = childThread?.messages.findLast((m) => m.role === 'assistant' && m.error);
    return failed ? classifySessionLogMessage(failed).error?.message : undefined;
  }, [childThread]);

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
