import { type QueryClient } from '@tanstack/react-query';
import type { Event as OpenCodeSdkEvent, Part } from '@opencode-ai/sdk/v2/client';
import type { RefObject } from 'react';
import {
  infoToast,
  notifyPermissionRequest,
  notifyQuestion,
  notifySessionError,
  notifyTaskComplete,
} from '../../platform/ui';
import { deleteSessionFromIDB, saveSessionToIDB } from '../../state/idb-sync-cache';
import { useSyncStore } from '../../state/sync-store';
import { getClient } from '../../opencode/client';
import { fileContentKeys, fileListKeys, gitStatusKeys } from '../file-keys';
import { ptyKeys } from '../use-opencode-pty';
import { type MessageWithParts, opencodeKeys, type Session } from '../use-opencode-sessions';
import { applyPartDiagnostics } from './diagnostics';
import {
  readSessionInfo,
  refetchKortixSessionMirrors,
  scheduleProjectMetadataRefetch,
} from './helpers';
import type { OpenCodeEvent } from './types';

/** Builds the SSE event handler; all closure dependencies are injected. */
export function createEventHandler(deps: {
  queryClient: QueryClient;
  client: ReturnType<typeof getClient>;
  applySyncEvent: (event: any) => void;
  stopCompaction: (sessionID: string) => void;
  addPermission: (req: any) => void;
  removePermission: (requestId: string) => void;
  addQuestion: (req: any) => void;
  removeQuestion: (requestId: string) => void;
  normalizeDiagnosticPaths: RefObject<(diagsByFile: Record<string, any[]>) => Record<string, any[]>>;
  markSessionAbortedLocally: RefObject<(sessionID: string, message?: string) => void>;
  fetchLspDiagnosticsDebounced: RefObject<() => void>;
}) {
  const {
    queryClient,
    client,
    applySyncEvent,
    stopCompaction,
    addPermission,
    removePermission,
    addQuestion,
    removeQuestion,
    normalizeDiagnosticPaths,
    markSessionAbortedLocally,
    fetchLspDiagnosticsDebounced,
  } = deps;

  // Helper: look up a session title from the React Query cache for notifications
  function getSessionTitle(sessionID: string): string | undefined {
    const sessions = queryClient.getQueryData<any[]>(opencodeKeys.sessions());
    if (sessions) {
      const s = sessions.find((s: any) => s.id === sessionID);
      if (s?.title) return s.title;
    }
    const session = queryClient.getQueryData<any>(opencodeKeys.session(sessionID));
    return session?.title || undefined;
  }

  function handleEvent(event: OpenCodeEvent) {
    // Sync store is the SINGLE source of truth for messages & parts.
    // This matches OpenCode's architecture where the SolidJS store is
    // the only place message/part data lives.
    applySyncEvent(event as OpenCodeSdkEvent);

    switch (event.type) {
      // ---- Message events — handled by sync store only ----
      case 'message.updated':
      case 'message.removed':
        break;

      case 'message.part.updated': {
        // Extract diagnostics from tool output and/or metadata
        const part = (event.properties as any).part as Part;
        applyPartDiagnostics(part, normalizeDiagnosticPaths);
        break;
      }

      case 'message.part.removed':
        break;

      // ---- Session lifecycle — surgical cache mutations (zero HTTP) ----
      //
      // IMPORTANT: Return the old array reference when nothing changed.
      // Creating new arrays on every SSE event causes cascading re-renders
      // in all session list consumers, which triggers a Radix UI compose-refs
      // infinite loop (Maximum update depth exceeded).
      case 'session.created': {
        const info = readSessionInfo(event);
        if (info) {
          queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
            if (!old) return [info];
            const exists = old.findIndex((s) => s.id === info.id);
            if (exists >= 0) {
              // Already exists — check if actually changed
              if (old[exists].time.updated === info.time.updated) return old;
              const next = [...old];
              next[exists] = info;
              return next.sort((a, b) => b.time.updated - a.time.updated);
            }
            return [info, ...old].sort((a, b) => b.time.updated - a.time.updated);
          });
          queryClient.setQueryData(opencodeKeys.session(info.id), info);
          refetchKortixSessionMirrors(queryClient);
        }
        break;
      }

      case 'session.updated': {
        const info = readSessionInfo(event);
        if (info) {
          // OpenCode auto-titles after the first message via session.updated.
          // Capture the previous title before local cache mutation so we only
          // force the server-owned mirror read when the title actually changed.
          const prevTitle =
            queryClient
              .getQueryData<Session[]>(opencodeKeys.sessions())
              ?.find((s) => s.id === info.id)?.title ??
            queryClient.getQueryData<Session>(opencodeKeys.session(info.id))?.title ??
            null;
          const titleChanged = !!info.title && info.title !== prevTitle;
          // Only update individual session cache (cheap, targeted)
          queryClient.setQueryData(opencodeKeys.session(info.id), info);
          // Update session list only if the session actually changed
          queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
            if (!old) return old;
            const idx = old.findIndex((s) => s.id === info.id);
            if (idx < 0) return old;
            // Shallow check: skip only if BOTH the timestamp and the title are
            // unchanged. Title alone can flip (opencode auto-titles) without a
            // perceptible time bump, and dropping that would keep the tab stale.
            if (
              old[idx].time.updated === info.time.updated &&
              old[idx].title === info.title
            )
              return old;
            const next = [...old];
            next[idx] = info;
            return next.sort((a, b) => b.time.updated - a.time.updated);
          });
          if (titleChanged) refetchKortixSessionMirrors(queryClient);
        }
        break;
      }

      case 'session.deleted': {
        const info = readSessionInfo(event);
        if (info) {
          queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
            if (!old) return old;
            const found = old.some((s) => s.id === info.id);
            if (!found) return old;
            return old.filter((s) => s.id !== info.id);
          });
          queryClient.removeQueries({ queryKey: opencodeKeys.session(info.id) });
          queryClient.removeQueries({ queryKey: opencodeKeys.messages(info.id) });
          deleteSessionFromIDB(info.id);
        }
        break;
      }

      case 'session.compacted': {
        const sessionID = (event.properties as any).sessionID;
        if (sessionID) {
          stopCompaction(sessionID);
          const client = getClient();
          client.session
            .messages({ sessionID })
            .then((res) => {
              if (res.data) {
                useSyncStore.getState().hydrate(sessionID, res.data as any);
                const s = useSyncStore.getState();
                const msgs = s.messages[sessionID] ?? [];
                if (msgs.length > 0) saveSessionToIDB(sessionID, msgs, s.parts);
              }
            })
            .catch(() => {});
          // Refetch the individual session to clear time.compacting
          // (targeted refetch, not full session list invalidation)
          client.session
            .get({ sessionID })
            .then((res) => {
              if (res.data) {
                const session = res.data as Session;
                queryClient.setQueryData(opencodeKeys.session(sessionID), session);
                // Also update in session list
                queryClient.setQueryData<Session[]>(opencodeKeys.sessions(), (old) => {
                  if (!old) return old;
                  const idx = old.findIndex((s) => s.id === sessionID);
                  if (idx < 0) return old;
                  const next = [...old];
                  next[idx] = session;
                  return next;
                });
              }
            })
            .catch(() => {});
        }
        break;
      }

      // ---- Session status ----
      case 'session.status': {
        const { sessionID, status } = event.properties as any;
        if (sessionID && status) {
          // Detect busy/retry → idle transition BEFORE updating the store
          // (coalescing can drop intermediate busy events, so we check here)
          const prevStatus = useSyncStore.getState().sessionStatus[sessionID];
          if (status.type === 'idle' && prevStatus && prevStatus.type !== 'idle') {
            notifyTaskComplete(sessionID, getSessionTitle(sessionID));
            // Agent finished editing files — refresh the Changes panel.
            // Nothing else invalidates git status for agent-driven edits,
            // so without this the panel shows stale diff state.
            queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
            queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
          }
        }
        break;
      }

      case 'session.idle': {
        const sessionID = (event.properties as any).sessionID;
        if (sessionID) {
          const prevStatus = useSyncStore.getState().sessionStatus[sessionID];
          if (prevStatus && prevStatus.type !== 'idle') {
            notifyTaskComplete(sessionID, getSessionTitle(sessionID));
            // Agent finished editing files — refresh the Changes panel.
            // Nothing else invalidates git status for agent-driven edits,
            // so without this the panel shows stale diff state.
            queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
            queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
            // Persist final session state to IDB when streaming completes
            const s = useSyncStore.getState();
            const msgs = s.messages[sessionID] ?? [];
            if (msgs.length > 0) saveSessionToIDB(sessionID, msgs, s.parts);
          }
        }
        break;
      }

      // ---- Session errors ----
      case 'session.error': {
        const props = event.properties as { sessionID?: string; error?: any };
        if (props.sessionID && props.error) {
          stopCompaction(props.sessionID);
          // Fire browser notification
          const errorTitle =
            props.error?.name || props.error?.data?.message || 'An error occurred';
          notifySessionError(props.sessionID, errorTitle, getSessionTitle(props.sessionID));

          // Patch the error onto the last assistant message in cache.
          // This is critical because:
          // 1. session.error arrives BEFORE message.updated with .error
          // 2. Some error paths (model-not-found, agent-not-found) never
          //    emit message.updated with .error at all
          // 3. Polling can race and overwrite the error from message.updated
          const key = opencodeKeys.messages(props.sessionID);
          queryClient.cancelQueries({ queryKey: key });
          queryClient.setQueryData<MessageWithParts[]>(key, (old) => {
            if (!old || old.length === 0) return old;
            // Find the last assistant message and patch error onto it
            for (let i = old.length - 1; i >= 0; i--) {
              if (old[i].info.role === 'assistant') {
                if ((old[i].info as any).error) return old; // already has error
                const updated = [...old];
                updated[i] = {
                  ...old[i],
                  info: { ...old[i].info, error: props.error } as any,
                };
                return updated;
              }
            }
            return old;
          });

          // Fetch real messages from the server to bring in
          // authoritative data. In error paths the server may never
          // send message.updated for the user message, leaving the
          // optimistic duplicate. After hydrating server data,
          // clear any optimistic messages (now superseded by real
          // ones) to prevent double user bubbles.
          //
          // EXCEPTION: On abort, skip the fetch+hydrate — the server
          // may not have persisted the partial assistant response yet,
          // so hydrating would wipe the streamed content the user saw.
          // The error is already patched onto the message above.
          const isAbortError =
            props.error?.name === 'AbortError' ||
            String(props.error?.data?.message || props.error?.message || '')
              .toLowerCase()
              .includes('abort');
          const sid = props.sessionID;
          if (!isAbortError) {
            client.session
              .messages({ sessionID: sid })
              .then((res) => {
                if (!res.data) return;
                useSyncStore.getState().hydrate(sid, res.data as any);
                useSyncStore.getState().clearOptimisticMessages(sid);
                const s = useSyncStore.getState();
                const msgs = s.messages[sid] ?? [];
                if (msgs.length > 0) saveSessionToIDB(sid, msgs, s.parts);
              })
              .catch(() => {});
          } else {
            // Still clear optimistic messages on abort — the real
            // user message should have arrived via SSE by now.
            useSyncStore.getState().clearOptimisticMessages(sid);
          }
        }
        break;
      }

      // ---- Permissions ----
      case 'permission.asked': {
        const props = event.properties as any;
        if (props.id && props.sessionID) {
          addPermission(props);
          // Fire browser notification for permission requests
          const toolName = props.tool || props.type || 'a tool';
          notifyPermissionRequest(props.sessionID, toolName, getSessionTitle(props.sessionID));
        }
        break;
      }
      case 'permission.replied': {
        const requestID = (event.properties as any).requestID;
        if (requestID) removePermission(requestID);
        break;
      }

      // ---- Questions ----
      case 'question.asked': {
        const props = event.properties as any;
        if (props.id && props.sessionID) {
          addQuestion(props);
          // Fire browser notification for questions needing user input
          const questionText =
            props.questions?.[0]?.question ||
            props.questions?.[0]?.header ||
            'Kortix needs your input';
          notifyQuestion(props.sessionID, questionText, getSessionTitle(props.sessionID));
        }
        break;
      }
      case 'question.replied':
      case 'question.rejected': {
        const requestID = (event.properties as any).requestID;
        if (requestID) removeQuestion(requestID);
        break;
      }

      // ---- Session diff ----
      case 'session.diff': {
        const props = event.properties as { sessionID: string; diff: any[] };
        if (props.sessionID) {
          queryClient.setQueryData(['opencode', 'session-diff', props.sessionID], props.diff);
        }
        break;
      }

      // ---- Todo updated ----
      case 'todo.updated': {
        const props = event.properties as { sessionID: string; todos: any[] };
        if (props.sessionID) {
          queryClient.setQueryData(['opencode', 'session-todo', props.sessionID], props.todos);
        }
        break;
      }

      // ---- VCS branch ----
      case 'vcs.branch.updated': {
        const props = event.properties as { branch: string };
        queryClient.setQueryData(['opencode', 'vcs'], {
          branch: props.branch,
        });
        break;
      }

      // ---- Server disposed ----
      case 'server.instance.disposed': {
        for (const [sessionID, status] of Object.entries(useSyncStore.getState().sessionStatus)) {
          if (status?.type !== 'idle') {
            markSessionAbortedLocally.current(
              sessionID,
              'The operation was aborted because the server instance was disposed.',
            );
          }
        }
        // Instance dispose means the server rescanned skills, agents,
        // tools, and commands. Invalidate all cached app metadata so
        // the UI picks up newly installed marketplace components or
        // agent-created skills/agents immediately.
        queryClient.invalidateQueries({ queryKey: opencodeKeys.sessions(), type: 'active' });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.skills(), type: 'active' });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.agents(), type: 'active' });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.commands(), type: 'active' });
        break;
      }

      // ---- LSP updated ----
      case 'lsp.updated': {
        queryClient.invalidateQueries({ queryKey: ['opencode', 'lsp'], type: 'active' });
        // A new LSP client connected — fetch diagnostics after a short
        // delay to give the language server time to produce initial results.
        fetchLspDiagnosticsDebounced.current();
        break;
      }

      // ---- LSP client diagnostics (per-file notification) ----
      case 'lsp.client.diagnostics': {
        // This event signals diagnostics changed for a specific file.
        // The event only carries { serverID, path } — actual diagnostic
        // data must be fetched from the /lsp/diagnostics endpoint.
        fetchLspDiagnosticsDebounced.current();
        break;
      }

      // ---- MCP tools changed ----
      case 'mcp.tools.changed': {
        // MCP server tools were added/removed/changed — refresh status + tool lists.
        // Only refetch if queries are actively mounted (type: 'active').
        queryClient.refetchQueries({ queryKey: opencodeKeys.mcpStatus(), type: 'active' });
        queryClient.refetchQueries({ queryKey: opencodeKeys.toolIds(), type: 'active' });
        break;
      }

      // ---- PTY events ----
      case 'pty.created':
      case 'pty.updated':
      case 'pty.exited':
      case 'pty.deleted': {
        queryClient.invalidateQueries({ queryKey: ptyKeys.listPrefix(), type: 'active' });
        break;
      }

      // ---- Worktree events — disabled for now ----
      case 'worktree.ready': {
        queryClient.invalidateQueries({ queryKey: opencodeKeys.worktrees(), type: 'active' });
        queryClient.invalidateQueries({ queryKey: opencodeKeys.projects(), type: 'active' });
        break;
      }

      case 'worktree.failed': {
        queryClient.invalidateQueries({ queryKey: opencodeKeys.worktrees(), type: 'active' });
        break;
      }

      // ---- Project updated ----
      case 'project.updated': {
        // Targeted refetch — project data is small and changes rarely,
        // but OpenCode can emit bursts while tools are running. Coalesce
        // these so a burst cannot spam /project/current.
        scheduleProjectMetadataRefetch(queryClient);
        break;
      }

      // ---- File edited (outside agent, e.g. user edits in editor) ----
      case 'file.edited': {
        const fileProps = event.properties as { file?: string };
        queryClient.invalidateQueries({ queryKey: fileListKeys.all, type: 'active' });
        queryClient.invalidateQueries({ queryKey: gitStatusKeys.all, type: 'active' });
        if (fileProps.file) {
          queryClient.invalidateQueries({ queryKey: fileContentKeys.all, type: 'active' });
        }
        break;
      }

      // ---- Installation events ----
      case 'installation.updated': {
        const installProps = event.properties as { version?: string };
        const versionStr = installProps.version ? ` (v${installProps.version})` : '';
        infoToast(`Installation updated${versionStr}. Restart to apply changes.`, {
          duration: 10_000,
        });
        break;
      }

      case 'installation.update-available': {
        const updateProps = event.properties as { version?: string };
        const versionLabel = updateProps.version ? `v${updateProps.version}` : 'A new version';
        infoToast(`${versionLabel} is available. Update when you're ready.`, {
          duration: 15_000,
        });
        break;
      }

      default:
        break;
    }
  }

  return handleEvent;
}
