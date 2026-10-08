import { useSyncStore } from '../../browser/stores/sync-store';
import { isAbortError } from '../../core/http/abort-error';
import { getClient } from '../../core/runtime/client';
import { notifySessionError, notifyTaskComplete } from '../../platform/ui';
import { type MessageWithParts, type Session, runtimeKeys } from '../use-opencode-sessions';
import type { HandlerContext } from './handler-context';
import {
  patchKortixSessionTitleMirrors,
  readSessionInfo,
  realRuntimeTitle,
  refetchKortixSessionMirrors,
} from './helpers';
import type { RuntimeEvent } from './types';
export function handleSessionEvent(event: RuntimeEvent, ctx: HandlerContext, statusBeforeEvent: ReturnType<typeof useSyncStore.getState>['sessionStatus'][string] | undefined) {
  if (event.type === 'session.created' || event.type === 'session.updated') handleSessionLifecycle(event, ctx);
  else if (event.type === 'session.deleted') handleSessionDeletion(event, ctx);
  else if (event.type === 'session.error') handleSessionFailure(event, ctx);
  else if (event.type === 'session.compacted') handleSessionCompaction(event, ctx);
  else handleSessionCompletion(event, ctx, statusBeforeEvent);
}
function handleSessionLifecycle(event: RuntimeEvent, ctx: HandlerContext) {
  const { queryClient, projectId } = ctx;
  switch (event.type) {
    case 'session.created': {
      const info = readSessionInfo(event);
      if (info) {
        useSyncStore.getState().syncSessionRevertFromInfo(info.id, info.revert ?? null);
        queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
          if (!old) return [info];
          const exists = old.findIndex((s) => s.id === info.id);
          if (exists >= 0) {
            if (old[exists].time.updated === info.time.updated) return old;
            const next = [...old];
            next[exists] = info;
            return next.sort((a, b) => b.time.updated - a.time.updated);
          }
          return [info, ...old].sort((a, b) => b.time.updated - a.time.updated);
        });
        queryClient.setQueryData(runtimeKeys.runtimeSession(info.id), info);
        patchKortixSessionTitleMirrors(
          queryClient,
          projectId,
          info.id,
          realRuntimeTitle(info.title),
        );
        refetchKortixSessionMirrors(queryClient, projectId);
      }
      break;
    }
    case 'session.updated': {
      const info = readSessionInfo(event);
      if (info) {
        useSyncStore.getState().syncSessionRevertFromInfo(info.id, info.revert ?? null);
        const prevTitle =
          queryClient.getQueryData<Session[]>(runtimeKeys.sessions())?.find((s) => s.id === info.id)
            ?.title ??
          queryClient.getQueryData<Session>(runtimeKeys.runtimeSession(info.id))?.title ??
          null;
        const titleChanged = !!info.title && info.title !== prevTitle;
        queryClient.setQueryData(runtimeKeys.runtimeSession(info.id), info);
        queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
          if (!old) return old;
          const idx = old.findIndex((s) => s.id === info.id);
          if (idx < 0) return old;
          if (old[idx].time.updated === info.time.updated && old[idx].title === info.title)
            return old;
          const next = [...old];
          next[idx] = info;
          return next.sort((a, b) => b.time.updated - a.time.updated);
        });
        if (titleChanged) {
          patchKortixSessionTitleMirrors(
            queryClient,
            projectId,
            info.id,
            realRuntimeTitle(info.title),
          );
          refetchKortixSessionMirrors(queryClient, projectId);
        }
      }
      break;
    }
    default:
      break;
  }
}
function handleSessionDeletion(event: RuntimeEvent, ctx: HandlerContext) {
  const { queryClient } = ctx;
  switch (event.type) {
    case 'session.deleted': {
      const info = readSessionInfo(event);
      if (info) {
        queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
          if (!old) return old;
          const found = old.some((s) => s.id === info.id);
          if (!found) return old;
          return old.filter((s) => s.id !== info.id);
        });
        queryClient.removeQueries({
          queryKey: runtimeKeys.runtimeSession(info.id),
        });
        queryClient.removeQueries({
          queryKey: runtimeKeys.runtimeMessages(info.id),
        });
      }
      break;
    }
    default:
      break;
  }
}
function handleSessionCompaction(event: RuntimeEvent, ctx: HandlerContext) {
  const { queryClient, stopCompaction, reconcileTail } = ctx;
  switch (event.type) {
    case 'session.compacted': {
      const sessionID = event.properties.sessionID;
      if (sessionID) {
        stopCompaction(sessionID);
        const client = getClient();
        void reconcileTail(sessionID, 'compaction');
        client.session
          .get({ sessionID })
          .then((res) => {
            if (res.data) {
              const session = res.data;
              queryClient.setQueryData(runtimeKeys.runtimeSession(sessionID), session);
              queryClient.setQueryData<Session[]>(runtimeKeys.sessions(), (old) => {
                if (!old) return old;
                const idx = old.findIndex((s) => s.id === sessionID);
                if (idx < 0) return old;
                const next = [...old];
                next[idx] = session;
                return next;
              });
            } else {
              void queryClient.invalidateQueries({
                queryKey: runtimeKeys.runtimeSession(sessionID),
              });
            }
          })
          .catch(() => {
            void queryClient.invalidateQueries({
              queryKey: runtimeKeys.runtimeSession(sessionID),
            });
          });
      }
      break;
    }
    default:
      break;
  }
}
function handleSessionCompletion(event: RuntimeEvent, ctx: HandlerContext, statusBeforeEvent: ReturnType<typeof useSyncStore.getState>['sessionStatus'][string] | undefined) {
  const { reconcileTail, getSessionTitle, invalidateWorkspaceFilesAfterTurn } = ctx;
  switch (event.type) {
    case 'session.next.revert.committed': {
      const { sessionID } = event.properties as { sessionID?: string };
      if (sessionID && useSyncStore.getState().sessionRevertNeedsTailReconcile[sessionID]) {
        useSyncStore.getState().clearSessionRevertNeedsTailReconcile(sessionID);
        void reconcileTail(sessionID, 'manual');
      }
      break;
    }
    case 'session.status': {
      const { sessionID, status } = event.properties;
      if (sessionID && status) {
        if (status.type === 'idle') void reconcileTail(sessionID, 'turn-end');
        const prevStatus = statusBeforeEvent;
        if (status.type === 'idle' && prevStatus && prevStatus.type !== 'idle') {
          notifyTaskComplete(sessionID, getSessionTitle(sessionID));
          invalidateWorkspaceFilesAfterTurn();
        }
      }
      break;
    }
    case 'session.idle': {
      const sessionID = event.properties.sessionID;
      if (sessionID) {
        void reconcileTail(sessionID, 'turn-end');
        const prevStatus = statusBeforeEvent;
        if (prevStatus && prevStatus.type !== 'idle') {
          notifyTaskComplete(sessionID, getSessionTitle(sessionID));
          invalidateWorkspaceFilesAfterTurn();
        }
      }
      break;
    }
    default:
      break;
  }
}
function handleSessionFailure(event: RuntimeEvent, ctx: HandlerContext) {
  const { queryClient, stopCompaction, reconcileTail, getSessionTitle } = ctx;
  switch (event.type) {
    case 'session.error': {
      const props = event.properties;
      if (props.sessionID && props.error) {
        const sessionID = props.sessionID;
        const error = props.error;
        stopCompaction(sessionID);
        const rawMessage = error.data.message;
        const errorTitle =
          error.name ||
          (typeof rawMessage === 'string' ? rawMessage : undefined) ||
          'An error occurred';
        notifySessionError(sessionID, errorTitle, getSessionTitle(sessionID));
        const key = runtimeKeys.runtimeMessages(sessionID);
        queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<MessageWithParts[]>(key, (old) => {
          if (!old || old.length === 0) return old;
          for (let i = old.length - 1; i >= 0; i--) {
            const info = old[i].info;
            if (info.role === 'assistant') {
              if (info.error) return old; // already has error
              const updated = [...old];
              updated[i] = {
                ...old[i],
                info: { ...info, error },
              };
              return updated;
            }
          }
          return old;
        });
        const aborted = isAbortError(error);
        if (!aborted) {
          reconcileTail(sessionID, 'session-error')
            .then(() => {
              useSyncStore.getState().clearOptimisticMessages(sessionID);
            })
            .catch(() => {});
        } else {
          useSyncStore.getState().clearOptimisticMessages(sessionID);
        }
      }
      break;
    }
    default:
      break;
  }
}
