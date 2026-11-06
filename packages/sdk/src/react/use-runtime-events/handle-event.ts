import type {
  Event as RuntimeWireEvent,
  PermissionRequest,
  QuestionRequest,
} from '../../core/runtime/runtime-types';
import type { QueryClient } from '@tanstack/react-query';
import type { RefObject } from 'react';
import { useSyncStore } from '../../browser/stores/sync-store';
import type { getClient } from '../../core/runtime/client';
import { binaryBlobKeys, fileContentKeys, fileListKeys, gitStatusKeys } from '../file-keys';
import { type Session, runtimeKeys } from '../use-runtime-sessions';
import { handleInteractionEvent } from './handle-interaction-event';
import { handleMessageEvent } from './handle-message-event';
import { handleSessionEvent } from './handle-session-event';
import { handleWorkspaceEvent } from './handle-workspace-event';
import { pendingEventsOfLogState, sessionStatusOfLogFrame } from './log-control';
import type { HandlerContext } from './handler-context';
import { cachedSessionName } from './helpers';
import type { NormalizeDiagnosticPaths, RuntimeEvent } from './types';
export function createEventHandler(deps: {
  queryClient: QueryClient;
  client: ReturnType<typeof getClient>;
  applySyncEvent: (event: RuntimeWireEvent) => void;
  stopCompaction: (sessionID: string) => void;
  addPermission: (req: PermissionRequest) => void;
  removePermission: (requestId: string) => void;
  addQuestion: (req: QuestionRequest) => void;
  removeQuestion: (requestId: string) => void;
  normalizeDiagnosticPaths: RefObject<NormalizeDiagnosticPaths>;
  markSessionAbortedLocally: RefObject<(sessionID: string, message?: string) => void>;
  fetchLspDiagnosticsDebounced: RefObject<() => void>;
  /** The route-scoped project this SSE connection belongs to — see
   *  `refetchKortixSessionMirrors`'s doc comment for why this can't default
   *  to "every project". Optional only so existing test harnesses that don't
   *  care about the Kortix-session-mirror refetch keep compiling; production
   *  always passes it (`use-runtime-events/index.ts`). */
  projectId?: string | null;
  /** Required, so a new call site cannot silently fall back to the host's URL. */
  notificationProjectId: string | null;
  /**
   * The Kortix session of the stream this handler serves (R5.3). Its `log.*`
   * frames go to that session's log (`applySessionLogEvent`); without it they
   * are dropped: the frames name no session.
   */
  sessionId?: string | null;
  /** A `log.status` `compacting` starts the thread's compaction; its next status ends it. */
  startCompaction?: (sessionID: string) => void;
}) {
  const { queryClient, client } = deps;
  const ctx: HandlerContext = {
    ...deps,
    projectId: deps.projectId ?? null,
    getSessionTitle(sessionID) {
      // The stream's session, not `sessionID`: a sub-agent's request names the
      // session the notification opens.
      const named =
        deps.projectId && deps.sessionId
          ? cachedSessionName(queryClient, deps.projectId, deps.sessionId)
          : undefined;
      if (named) return named;
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
    if (event.type.startsWith('log.')) {
      if (deps.sessionId) useSyncStore.getState().applySessionLogEvent(deps.sessionId, event);
      // The control frames drive the stores the runtime's own events drive.
      const status = sessionStatusOfLogFrame(event);
      if (status) {
        const compacting = (event.properties as { status?: unknown }).status === 'compacting';
        if (compacting) deps.startCompaction?.(status.properties.sessionID);
        else deps.stopCompaction(status.properties.sessionID);
        const before = useSyncStore.getState().sessionStatus[status.properties.sessionID];
        deps.applySyncEvent(status as RuntimeWireEvent);
        handleSessionEvent(status, ctx, before);
      }
      if ((event.type as string) === 'log.state' && deps.sessionId) {
        const threads = Object.keys(useSyncStore.getState().sessionLogs[deps.sessionId]?.threads ?? {});
        for (const interaction of pendingEventsOfLogState(event, threads)) handleInteractionEvent(interaction, ctx);
      }
      return;
    }
    deps.applySyncEvent(event as RuntimeWireEvent);
    if (event.type.startsWith('message.')) handleMessageEvent(event, ctx);
    else if (event.type.startsWith('session.') && event.type !== 'session.diff')
      handleSessionEvent(event, ctx, statusBeforeEvent);
    else if (event.type.startsWith('permission.') || event.type.startsWith('question.'))
      handleInteractionEvent(event, ctx);
    else handleWorkspaceEvent(event, ctx);
  };
}
