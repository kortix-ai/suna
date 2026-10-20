'use client';

import { startSessionWithPrompt, writeStartStash } from '@kortix/sdk/react';
import { useCallback, useState } from 'react';

import { useTranslations } from '../../i18n';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import { errorToast } from '../../primitives/toast';
import {
  postWhenUploaded,
  sentFailureMessage,
  type AttachmentSubmission,
} from '../../session/composer/attachment-submission';
import type { AttachedFile } from '../../session/composer/session-chat-input';
import { useFirstPromptPreviewStore } from '../../session/composer/stores/session-composer-handoff-store';
import { promptFileParts } from '../../session/composer/uploaded-file-refs';
import { buildNewSessionCreateInput } from './new-session-create';
import type { ProjectHomeSendOptions } from './project-home';

export interface UseProjectHomeSendOptions {
  /**
   * Runs first on every send. Throw to refuse it: the composer keeps the draft.
   * apps/web checks the account's billing state here.
   */
  beforeSend?: () => Promise<void>;
}

/**
 * The project home composer's send: create the session (with the prompt as
 * its first message when the uploads are done), open it, and show the
 * message on its first frame. `ProjectHome` uses it when the host passes no
 * `onSend`.
 */
export function useProjectHomeSend(projectId: string, { beforeSend }: UseProjectHomeSendOptions = {}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tComposerAttachments = useTranslations('hardcodedUi.composerAttachments');
  const newSession = useNewProjectSession(projectId);
  // Composer sending state: spans Enter → create confirmed → navigation. Reset
  // only on create failure (success navigates this page away).
  const [sending, setSending] = useState(false);

  const send = useCallback(
    async (
      text: string,
      files: AttachedFile[] | undefined,
      options?: ProjectHomeSendOptions,
      attachments?: AttachmentSubmission,
    ) => {
      if (!text.trim() && !files?.length) return;
      await beforeSend?.();

      // Identical create-first path to every other new-session entry point: the
      // composer shows a sending spinner for the create RTT (~one round trip),
      // then navigates into the instant shell, which auto-sends `text` once the
      // box is ready. Bind the chosen agent at session birth so
      // `project_sessions.agent_name` is honest from turn one (see
      // buildNewSessionCreateInput).
      setSending(true);
      // Send time, not POST time. A held POST lands after the uploads, and the
      // server orders rows by this stamp: a message sent on the session page
      // meanwhile must still follow this one.
      const sentAtMs = Date.now();
      // Uploads still running at Send never hold the paint. The session is
      // created and opened now, and the first-prompt preview draws the message.
      // Only the prompt POST waits for the uploads: the create cannot carry a
      // prompt whose upload handles do not exist yet.
      const heldAttachments = attachments && !attachments.readyAtSend ? attachments : undefined;
      let parts: ReturnType<typeof promptFileParts> = [];
      if (!heldAttachments) {
        try {
          const attachmentParts = attachments ? await attachments.whenReady() : [];
          parts = promptFileParts(files, attachmentParts);
        } catch (error) {
          errorToast(error instanceof Error ? error.message : tI18nComplete.raw('texta9c0123d9962'));
          setSending(false);
          throw error;
        }
      }
      // This page unmounts with the navigation; the held POST does not. A
      // failure stays on the session page as the first prompt's failed status.
      // It starts at most once per Send.
      let heldPostStarted = false;
      const startHeldPost = (held: AttachmentSubmission, sessionId: string) => {
        if (heldPostStarted) return;
        heldPostStarted = true;
        void postWhenUploaded(
          sessionId,
          held,
          async (attachmentParts) =>
            startSessionWithPrompt(projectId, sessionId, {
              parts: [{ type: 'text' as const, text }, ...promptFileParts(files, attachmentParts)],
              overrides: {
                ...(options?.agent ? { agent: options.agent } : {}),
                ...(options?.model ? { model: options.model } : {}),
                ...(options?.variant ? { variant: options.variant } : {}),
              },
              clientSentAtMs: sentAtMs,
            }),
          (uploadStatus) =>
            useFirstPromptPreviewStore
              .getState()
              .setFirstPromptPreview(sessionId, text, files ?? [], uploadStatus),
          (error) => sentFailureMessage(error, tComposerAttachments),
        );
      };
      // A refused create can still open the session: the connector gate's Retry
      // creates it with these same options. By then the Promise below has
      // rejected, so nothing after the `await` runs.
      let refused = false;
      const sessionId = await new Promise<string>((resolve, reject) => {
        newSession({
          create: {
            ...buildNewSessionCreateInput(options),
            ...(heldAttachments
              ? {}
              : {
                  pending_prompt: {
                    text,
                    agent: options?.agent ?? null,
                    model: options?.model ?? null,
                    variant: options?.variant ?? null,
                    attachment_names:
                      files?.map((file) => (file.kind === 'local' ? file.file.name : file.filename)) ??
                      [],
                    ...(parts.length > 0 ? { parts: [{ type: 'text' as const, text }, ...parts] } : {}),
                  },
                }),
          },
          scope: options?.scope,
          // Create failed (already surfaced by the hook). Reject so the
          // composer restores its submitted draft and keeps every handle.
          onError: () => {
            refused = true;
            setSending(false);
            reject(new Error('Session creation failed'));
          },
          onNavigate: (sessionId) => {
            // PICKS only: the prompt is already a durable inbox row via
            // create.pending_prompt above. The session page's `migrateStash`
            // hands this stash off onto the resolved runtime session.
            writeStartStash(sessionId, {
              prompt: '',
              agent: options?.agent ?? null,
              model: options?.model ?? null,
              variant: options?.variant ?? null,
            });
            // RENDER-only copy for the boot shell, so the bubble is on screen
            // from the session page's first frame.
            useFirstPromptPreviewStore.getState().setFirstPromptPreview(sessionId, text, files ?? []);
            // A connector-gate Retry of a held send: hand the uploads off again
            // and POST from here. A ready send's create carried the prompt.
            if (refused && heldAttachments) {
              heldAttachments.resubmit();
              startHeldPost(heldAttachments, sessionId);
            }
            resolve(sessionId);
          },
        });
      });
      if (!heldAttachments) {
        attachments?.release();
        return;
      }
      startHeldPost(heldAttachments, sessionId);
    },
    [beforeSend, newSession, projectId, tI18nComplete, tComposerAttachments],
  );

  return { send, sending };
}
