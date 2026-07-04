'use client';

import { ToolSurfaceContext } from '@/features/session/tool/shared/infrastructure';
import { ToolPartRenderer } from '@/features/session/tool/tool-part-renderer';
import type { MessageWithParts, ToolPart } from '@/ui';
import { SessionRetryDisplay, TurnErrorDisplay } from '@/features/session/session-error-banner';
import { getChildSessionError, getRetryInfo, getRetryMessage } from '@/ui';
import { useSyncStore } from '@/stores/opencode-sync-store';
import { useEffect, useMemo, useState } from 'react';

export function SubAgentActivity({
  childSessionId,
  parts,
}: {
  childSessionId?: string;
  parts: ToolPart[];
}) {
  if (parts.length === 0) return null;
  return (
    <ToolSurfaceContext.Provider value="inline">
      <div className="space-y-1">
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
  const childStatus = useSyncStore((s) =>
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
        className="mt-2"
      />
    );
  }

  if (childError) {
    return <TurnErrorDisplay errorText={childError} className="mt-2" />;
  }

  return null;
}

