import type { Event as OpenCodeSdkEvent, PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2/client';
import type { QueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import type { getClient } from '../../core/runtime/client';
import type { SessionSyncReason } from '../../core/session-sync/session-sync-controller';
import { useSyncStore } from '../../browser/stores/sync-store';
import { SESSION_SYNC_PAGE_SIZE } from '../../core/session-sync/session-sync-controller';
import { binaryBlobKeys, fileContentKeys, fileListKeys, gitStatusKeys } from '../file-keys';
import { type Session, runtimeKeys } from '../use-opencode-sessions';
import { handleInteractionEvent } from './handle-interaction-event';
import { handleMessageEvent } from './handle-message-event';
import { handleSessionEvent } from './handle-session-event';
import { handleWorkspaceEvent } from './handle-workspace-event';
import type { HandlerContext } from './handler-context';
import type { NormalizeDiagnosticPaths, RuntimeEvent } from './types';
export const USER_PARTS_GRACE_MS = 1_500;
export function createEventHandler(deps: {
  queryClient: QueryClient;
  client: ReturnType<typeof getClient>;
  applySyncEvent: (event: OpenCodeSdkEvent) => void;
  stopCompaction: (sessionID: string) => void;
  addPermission: (req: PermissionRequest) => void;
  removePermission: (requestId: string) => void;
  addQuestion: (req: QuestionRequest) => void;
  removeQuestion: (requestId: string) => void;
  normalizeDiagnosticPaths: RefObject<NormalizeDiagnosticPaths>;
  markSessionAbortedLocally: RefObject<(sessionID: string, message?: string) => void>;
  fetchLspDiagnosticsDebounced: RefObject<() => void>;
  reconcileSessionTail?: (sessionID: string, reason: SessionSyncReason) => Promise<void>;
  /**
   * How long a USER `message.updated` may sit with no parts before the tail is
   * re-read. The runtime emits the info frame and the text part separately;
   * lose the part (a stream reconnect during the boot hand-off) and the
   * transcript shows an empty bubble until a reload. Injected so tests can
   * make it immediate.
   */
  userPartsGraceMs?: number;
  /** The route-scoped project this SSE connection belongs to — see
   *  `refetchKortixSessionMirrors`'s doc comment for why this can't default
   *  to "every project". Optional only so existing test harnesses that don't
   *  care about the Kortix-session-mirror refetch keep compiling; production
   *  always passes it (`use-opencode-events/index.ts`). */
  projectId?: string | null;
}) {
  const { queryClient, client } = deps;
  const reconcileTail =
    deps.reconcileSessionTail ??
    (async (sessionID: string) => {
      const result = await client.session.messages({ sessionID, limit: SESSION_SYNC_PAGE_SIZE });
      if (result.data) useSyncStore.getState().hydrate(sessionID, result.data);
    });
  const ctx: HandlerContext = {
    ...deps,
    projectId: deps.projectId ?? null,
    userPartsGraceMs: deps.userPartsGraceMs ?? USER_PARTS_GRACE_MS,
    reconcileTail,
    getSessionTitle(sessionID) {
      const sessions = queryClient.getQueryData<Session[]>(runtimeKeys.sessions());
      return (
        sessions?.find((s) => s.id === sessionID)?.title ||
        queryClient.getQueryData<Session>(runtimeKeys.runtimeSession(sessionID))?.title ||
        undefined
      );
    },
    invalidateWorkspaceFilesAfterTurn() {
      for (const queryKey of [
        gitStatusKeys.all,
        runtimeKeys.vcsDiffAll(),
        fileListKeys.all,
        fileContentKeys.all,
        binaryBlobKeys.all,
      ])
        queryClient.invalidateQueries({ queryKey });
    },
  };
  return (event: RuntimeEvent) => {
    const sessionID =
      event.type === 'session.status' || event.type === 'session.idle'
        ? event.properties.sessionID
        : undefined;
    const statusBeforeEvent = sessionID
      ? useSyncStore.getState().sessionStatus[sessionID]
      : undefined;
    deps.applySyncEvent(event as OpenCodeSdkEvent);
    if (event.type.startsWith('message.')) handleMessageEvent(event, ctx);
    else if (event.type.startsWith('session.') && event.type !== 'session.diff')
      handleSessionEvent(event, ctx, statusBeforeEvent);
    else if (event.type.startsWith('permission.') || event.type.startsWith('question.'))
      handleInteractionEvent(event, ctx);
    else handleWorkspaceEvent(event, ctx);
  };
}
