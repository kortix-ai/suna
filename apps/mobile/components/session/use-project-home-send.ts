import { useToast } from '@/components/kortix/toast-provider';
import type { ProjectHomeSubmit } from '@/components/session/ProjectHome';
import type { SessionConnectError } from '@/components/session/SessionConnecting';
import { appIsActive } from '@/hooks/useWarmProjectSession';
import { log } from '@/lib/logger';
import { requestPushPermissionOnce } from '@/lib/notifications/registration';
import { listCreatedSession, useCreateProjectSession } from '@/lib/projects/hooks';
import type { AttachedFile } from '@/lib/session/attachments';
import { draftKey } from '@/lib/session/composer-draft';
import { createSessionCommitted } from '@/lib/session/create-session';
import { newSessionCreateInput } from '@/lib/session/new-session-input';
import { warmSessionPool } from '@/lib/session/warm-session-pool';
import { clearComposerDraftIfSent } from '@/stores/composer-draft-store';
import { getProjectSession } from '@kortix/sdk';
import { newConfigPrompt, splitPastedContent } from '@kortix/shared';
import { useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import type React from 'react';
import { useCallback, useState } from 'react';

/**
 * The project-home send flow (the dashboard send), lifted out of ProjectScreen:
 * a send on the project home creates the project session with the composer's
 * first prompt and drops the screen into the connecting state, where the
 * connect engine (`useProjectSessionConnect`) takes over. Owns nothing else:
 * the connect pieces it drives arrive through `connect`.
 */
export function useProjectHomeSend(
  projectId: string,
  connect: {
    refreshSessionLists: () => void;
    firstPromptRef: React.RefObject<Record<string, { text: string; files: AttachedFile[] }>>;
    navigateToSession: (sessionId: string | null) => void;
    setConnectError: React.Dispatch<React.SetStateAction<SessionConnectError | null>>;
    erroredSessionRef: React.RefObject<string | null>;
    freshSessionIdRef: React.RefObject<string | null>;
    setConnectingProjectSessionId: React.Dispatch<React.SetStateAction<string | null>>;
    showUpgradeForError: (error: unknown) => boolean;
  },
) {
  const {
    refreshSessionLists,
    firstPromptRef,
    navigateToSession,
    setConnectError,
    erroredSessionRef,
    freshSessionIdRef,
    setConnectingProjectSessionId,
    showUpgradeForError,
  } = connect;
  // Simplified project-home send flow (ported from web 3f150e0). Creates a
  // project session with the first prompt and drops into the connecting
  // state — the effect provisions and opens it once ready. Resolves `true`
  // once the session exists, `false` on any failure (ProjectHome then keeps
  // the draft and hands its uploads back to the composer).
  const [isDashboardSending, setIsDashboardSending] = useState(false);
  const createProjectSession = useCreateProjectSession(projectId);
  const queryClient = useQueryClient();
  const toast = useToast();

  const handleDashboardSend = useCallback(
    async ({
      text,
      files,
      fileParts,
      model,
      picks,
      agent,
    }: ProjectHomeSubmit): Promise<boolean> => {
      if (!projectId || isDashboardSending) return false;
      if (!text.trim() && files.length === 0) return false;

      setIsDashboardSending(true);
      try {
        // Files are already uploaded (ProjectHome's `useComposerAttachments`)
        // and ride the create as `pending_prompt.parts`, which the server
        // delivers once the runtime is up. The model is baked in at create.
        // A thinking level cannot ride `initial_prompt` (it carries text only),
        // so a send with a level uses `pending_prompt` too
        // (`lib/session/new-session-input.ts`).
        const hasFiles = files.length > 0;
        // Warm path (web parity, `lib/session/warm-session.ts`): the project
        // keeps one session booted while this screen is open. A send on the
        // project defaults claims it with its first prompt, so the sandbox
        // boot is already done. A send with files never fits it
        // (`warmFitsSend`). Anything it does not fit, or a refused claim,
        // runs the ordinary create below with the same prompt.
        const warm = warmSessionPool.take(
          projectId,
          { agentName: agent, model, hasFiles },
          { replenish: appIsActive() },
        );
        const claimedWarm =
          warm &&
          (await warmSessionPool.prime(
            projectId,
            warm,
            { text, agent, model: picks?.model ?? null, variant: picks?.variant ?? null },
            agent,
          ))
            ? warm.sessionId
            : null;
        if (claimedWarm) {
          log.log('🔥 [Project] Home send took the warm session');
        }
        // Ordinary create (web parity, COR-185): the client mints the id, so a
        // timed-out create that committed is read back and used instead of
        // letting a re-send create a second session. Created FIRST, then the
        // connecting state below: a failed create never shows a live-looking
        // session. The composer's send slot shows the spinner meanwhile.
        const createNew = async (): Promise<string> => {
          const sessionId = Crypto.randomUUID();
          const input = newSessionCreateInput({
            sessionId,
            text,
            fileParts,
            fileNames: files.map((f) => f.name),
            model,
            picks,
            agent,
          });
          return createSessionCommitted(
            {
              create: (body) => createProjectSession.mutateAsync(body),
              read: async (id) => {
                const row = await getProjectSession(projectId, id, { showErrors: false });
                // A create that timed out but committed: listed now, like
                // one that answered (`useCreateProjectSession`).
                listCreatedSession(queryClient, projectId, row);
                return row;
              },
            },
            { ...input, session_id: sessionId },
          );
        };
        const session = { session_id: claimedWarm ?? (await createNew()) };
        // The lists learn of the new session now, not at their next poll —
        // also after a timed-out create that committed (`createSessionCommitted`).
        refreshSessionLists();
        // The loading page's first message and file tiles, and "Back to
        // project"'s draft restore, all key off this. An image-only send
        // sets it too, so the loading page shows the photo.
        if (text.trim() || hasFiles) {
          firstPromptRef.current[session.session_id] = { text: text.trim(), files };
        }
        // Enter the connecting state — the effect drives provisioning and opens
        // the server-created session once ready.
        navigateToSession(null);
        setConnectError(null);
        erroredSessionRef.current = null;
        freshSessionIdRef.current = session.session_id;
        setConnectingProjectSessionId(session.session_id);
        // The session holds the prompt now: drop the home's saved draft
        // (COR-143). Cancel hands the text back through `takeInitialDraft`.
        // The saved draft is the typed text only: compare it without the paste tiles.
        clearComposerDraftIfSent(draftKey({ kind: 'project', projectId }), splitPastedContent(text).text);
        // The first send asks for notification permission, once per install.
        void requestPushPermissionOnce();
        return true;
      } catch (err: any) {
        if (showUpgradeForError(err)) return false;
        log.error('❌ [Project] Home send failed:', err?.message || err);
        toast.error(err?.message || 'Failed to start session');
        return false;
      } finally {
        setIsDashboardSending(false);
      }
    },
    [
      projectId,
      isDashboardSending,
      createProjectSession,
      queryClient,
      navigateToSession,
      showUpgradeForError,
      toast,
      refreshSessionLists,
    ],
  );

  // The model sheet's Agent tab `+` (thread and home alike): a new session on
  // the shared "configure a new agent" prompt, web's Agents page "New". Same
  // create + connecting path as a project-home send.
  const handleCreateAgent = useCallback(() => {
    void handleDashboardSend({
      text: newConfigPrompt('agent'),
      files: [],
      fileParts: [],
      model: null,
      picks: null,
      agent: null,
    });
  }, [handleDashboardSend]);
  return { isDashboardSending, handleDashboardSend, handleCreateAgent };
}
