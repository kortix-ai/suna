/**
 * A sub-agent's live activity under the row that dispatched it.
 *
 * Mirrors apps/web `tool/shared/sub-agent.tsx`. It lives with the agents
 * family (not in `tool/shared/`) because it renders `ToolPartRenderer`.
 *
 * ── Where the child session's data comes from ───────────────────────────────
 * The child's thread is `useSessionLogThread` of the bound session (web
 * P5.7 `useSubAgentThread`; here `useRuntimeThread`), by the child's runtime session id. On v2 the
 * API's session log holds it; on v1 it is the `fromV1` view of the child's
 * rows, which the SDK's reducer files under the child's `sessionID` from the
 * parent's stream. It never fetches. A child transcript is resident while the
 * parent streamed it; after eviction (`DETACHED_SESSION_LIMIT`) the row has no
 * steps and falls back to opening the child session, exactly as web does.
 *
 * - `SubAgentActivity` — the child's steps, each drawn by its own registered
 *   renderer, indented to the parent's text column (`useToolIndent`), on the
 *   inline surface, with navigation off (web `disableNavigation`);
 * - `SubAgentStatusBanner` — the child's retry countdown or its last error.
 */

import { useContext, useMemo } from 'react';
import { View } from 'react-native';
import {
  classifySessionLogMessage,
  subAgentCalls,
  getRetryInfo,
  getRetryMessage,
  type SessionLogThread,
  type ToolCallBlock,
} from '@kortix/sdk';
import { SessionRetryDisplay, useRetrySecondsLeft } from '@/components/session/session-retry-display';
import { TurnErrorDisplay } from '@/components/session/SessionErrorBanner';
import { useRuntimeThread } from '@/components/session/SessionRuntime';
import { useSessionStatus } from '@/lib/session/session-store';
import { webSpace } from '@/lib/session/user-message';
import { TurnLiveContext } from '../shared/infrastructure';
import { ToolNavigationContext } from '../shared/navigation';
import { ToolSurfaceContext, useToolIndent } from '../shared/surface';
import { ToolPartRenderer } from '../tool-part-renderer';

/** The child's thread plus its shown tool calls, memoised on the thread. */
export function useChildSession(childSessionId: string | undefined) {
  const childThread = useRuntimeThread(childSessionId);
  const childCalls = useMemo(() => subAgentCalls(childThread), [childThread]);
  return { childThread, childCalls };
}

export function SubAgentActivity({ childSessionId, calls }: { childSessionId?: string; calls: readonly ToolCallBlock[] }) {
  // Read BEFORE the provider flips the surface: the offset belongs to the row
  // this list hangs under.
  const indent = useToolIndent();
  // A background spawn returns at once: the parent's turn ends while the child
  // keeps working. The child's rows are live while either one is.
  const parentLive = useContext(TurnLiveContext);
  const childStatus = useSessionStatus(childSessionId);
  const childLive = parentLive || (!!childStatus && childStatus.type !== 'idle');

  if (calls.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <ToolNavigationContext.Provider value={false}>
        <TurnLiveContext.Provider value={childLive}>
          <View style={{ rowGap: webSpace(1), marginLeft: indent }}>
            {calls.map((call) => (
              <ToolPartRenderer key={call.call_id} call={call} sessionId={childSessionId} />
            ))}
          </View>
        </TurnLiveContext.Provider>
      </ToolNavigationContext.Provider>
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
  const childStatus = useSessionStatus(childSessionId);
  const retryInfo = useMemo(() => getRetryInfo(childStatus), [childStatus]);
  const retryMessage = useMemo(() => getRetryMessage(childStatus), [childStatus]);
  // The newest reply's error, as the transcript words a turn error (web P5.7).
  const childError = useMemo(() => {
    const messages = childThread?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.error) return classifySessionLogMessage(m).error?.message;
    }
    return undefined;
  }, [childThread]);
  const secondsLeft = useRetrySecondsLeft(retryInfo);

  if (retryInfo && retryMessage) {
    return (
      <SessionRetryDisplay
        message={retryMessage}
        attempt={retryInfo.attempt}
        secondsLeft={secondsLeft}
        details={retryInfo.details}
        style={{ marginTop: webSpace(2) }}
      />
    );
  }

  if (childError) {
    return <TurnErrorDisplay errorText={childError} style={{ marginTop: webSpace(2) }} />;
  }

  return null;
}
