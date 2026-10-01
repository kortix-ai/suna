import type { Event as OpenCodeSdkEvent } from '@opencode-ai/sdk/v2/client';
import { useSyncStore } from '../../browser/stores/sync-store';
import { SESSION_SYNC_PAGE_SIZE } from '../../core/session-sync/session-sync-controller';
import { binaryBlobKeys, fileContentKeys, fileListKeys, gitStatusKeys } from '../file-keys';
import { type Session, runtimeKeys } from '../use-opencode-sessions';
import { handleInteractionEvent } from './handle-interaction-event';
import { handleMessageEvent } from './handle-message-event';
import { handleSessionEvent } from './handle-session-event';
import { handleWorkspaceEvent } from './handle-workspace-event';
import type { HandlerContext } from './handler-context';
import type { RuntimeEvent } from './types';
export const USER_PARTS_GRACE_MS = 1_500;
export function createEventHandler(
  deps: Omit<
    HandlerContext,
    | 'reconcileTail'
    | 'getSessionTitle'
    | 'invalidateWorkspaceFilesAfterTurn'
    | 'userPartsGraceMs'
    | 'projectId'
  > & { projectId?: string | null } & {
    reconcileSessionTail?: HandlerContext['reconcileTail'];
    userPartsGraceMs?: number;
  },
) {
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
