/** Session synchronization through the framework-free @kortix/sdk controller. */

import { getAuthToken } from '@/api/config';
import {
  createHttpSessionSyncController,
  type SessionSyncMessage,
} from '@kortix/sdk';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useSyncStore } from './sync-store';
import type { MessageWithParts } from './types';

export function useSessionSync(
  sandboxUrl: string | undefined,
  sessionId: string | undefined,
) {
  const controller = useMemo(() => {
    if (!sandboxUrl || !sessionId) return null;
    return createHttpSessionSyncController({
      baseUrl: sandboxUrl,
      sessionId,
      getToken: getAuthToken,
      hydrate: (messages: SessionSyncMessage[]) => {
        // Mobile still carries a legacy local OpenCode type mirror. The wire
        // payload is identical; keep the compatibility assertion at this one
        // adapter boundary until that mirror is retired.
        useSyncStore
          .getState()
          .hydrate(sessionId, messages as unknown as MessageWithParts[]);
      },
      markLoaded: () => {
        const store = useSyncStore.getState();
        if (!(sessionId in store.messages)) store.hydrate(sessionId, []);
      },
      setStatus: (status) => {
        useSyncStore.getState().setStatus(sessionId, status);
      },
    });
  }, [sandboxUrl, sessionId]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? EMPTY_SNAPSHOT,
    controller?.getSnapshot ?? EMPTY_SNAPSHOT,
  );
  const status = useSyncStore((state) =>
    sessionId ? state.sessionStatus[sessionId] : undefined,
  );
  const messages = useSyncStore((state) =>
    sessionId ? state.messages[sessionId] : undefined,
  );

  useEffect(() => {
    if (!controller) return;
    void controller.start();
    return () => controller.destroy();
  }, [controller]);

  useEffect(() => {
    if (messages) controller?.noteActivity();
  }, [controller, messages]);

  useEffect(() => {
    controller?.setBusy(status?.type === 'busy' || status?.type === 'retry');
  }, [controller, status?.type]);

  return {
    ...snapshot,
    loadOlder: () => controller?.loadOlder() ?? Promise.resolve(),
  };
}

const EMPTY_SNAPSHOT = () => ({
  freshness: 'idle' as const,
  hasOlder: false,
  isLoadingOlder: false,
});
