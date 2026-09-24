/**
 * A sub-agent's live activity under the row that dispatched it.
 *
 * Mirrors apps/web `tool/shared/sub-agent.tsx`. It lives with the agents
 * family (not in `tool/shared/`) because it renders `ToolPartRenderer`.
 *
 * ── Where the child session's data comes from ───────────────────────────────
 * Web reads `useRuntimeMessages(childSessionId)`, a selector over the SDK sync
 * store: the parent's SSE stream carries every session's `message.updated` /
 * `message.part.updated` events, the reducer files them under the child's
 * `sessionID`, and the row reads them back. It never fetches.
 * Mobile's reducer (`lib/opencode/event-stream.ts`) does the same into
 * `lib/opencode/sync-store.ts`, so `useChildSessionMessages` is the same
 * selector over the same data. A child transcript is resident while the parent
 * streamed it; after eviction (`DETACHED_SESSION_LIMIT`) the row has no steps
 * and falls back to opening the child session, exactly as web does.
 *
 * - `SubAgentActivity` — the child's steps, each drawn by its own registered
 *   renderer, indented to the parent's text column (`useToolIndent`), on the
 *   inline surface, with navigation off (web `disableNavigation`);
 * - `SubAgentStatusBanner` — the child's retry countdown or its last error.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { getChildSessionError, getRetryInfo, getRetryMessage, type ToolPart } from '@kortix/sdk';
import { SessionRetryDisplay, useRetrySecondsLeft } from '@/components/session/session-retry-display';
import { TurnErrorDisplay } from '@/components/session/SessionErrorBanner';
import { useSyncStore } from '@/lib/opencode/sync-store';
import type { MessageWithParts } from '@/lib/opencode/types';
import { childSessionToolParts } from '@/lib/session/tools/agents-task';
import { webSpace } from '@/lib/session/user-message';
import { ToolNavigationContext } from '../shared/navigation';
import { ToolSurfaceContext, useToolIndent } from '../shared/surface';
import { ToolPartRenderer } from '../tool-part-renderer';

/** The child session's messages from the sync store (web `useRuntimeMessages`). */
export function useChildSessionMessages(childSessionId: string | undefined): MessageWithParts[] | undefined {
  return useSyncStore((s) => {
    if (!childSessionId) return undefined;
    const messages = s.messages[childSessionId];
    return messages && messages.length > 0 ? messages : undefined;
  });
}

/** The child session's messages plus its visible tool parts, memoised on the message list. */
export function useChildSession(childSessionId: string | undefined) {
  const childMessages = useChildSessionMessages(childSessionId);
  const childToolParts = useMemo(() => childSessionToolParts(childMessages), [childMessages]);
  return { childMessages, childToolParts };
}

export function SubAgentActivity({ childSessionId, parts }: { childSessionId?: string; parts: ToolPart[] }) {
  // Read BEFORE the provider flips the surface: the offset belongs to the row
  // this list hangs under.
  const indent = useToolIndent();

  if (parts.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <ToolNavigationContext.Provider value={false}>
        <View style={{ rowGap: webSpace(1), marginLeft: indent }}>
          {parts.map((tp) => (
            <ToolPartRenderer key={tp.callID} part={tp} sessionId={childSessionId} />
          ))}
        </View>
      </ToolNavigationContext.Provider>
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
  const childStatus = useSyncStore((s) => (childSessionId ? s.sessionStatus[childSessionId] : undefined));
  const retryInfo = useMemo(() => getRetryInfo(childStatus), [childStatus]);
  const retryMessage = useMemo(() => getRetryMessage(childStatus), [childStatus]);
  const childError = useMemo(
    () => getChildSessionError(childMessages as Parameters<typeof getChildSessionError>[0]),
    [childMessages],
  );
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
