import { errorToast } from '@/components/ui/toast';
import { promptFileParts } from '@/features/session/uploaded-file-refs';
import { buildNewSessionCreateInput } from '@/features/workspace/project-layout/new-session-create';
import type { ProjectHomeSendOptions } from '@/features/workspace/project-layout/project-home';
import type { NewProjectSessionOpts } from '@/hooks/projects/use-new-project-session';
import type { UiTranslator } from '@/i18n/translator';
import { useFirstPromptPreviewStore } from '@/stores/session-composer-handoff-store';
import { startSessionWithPrompt, writeStartStash } from '@kortix/sdk/react';
import {
  type AttachmentFailureReason,
  type AttachmentSubmission,
  type SENT_FAILURE_COPY,
  postWhenUploaded,
  sentFailureMessage,
} from './attachment-submission';
import type { AttachedFile } from './types';

/**
 * The project-home send's create-first delivery, moved out of the page's
 * `handleSend` beside the `AttachmentSubmission` owner it hands off to.
 *
 * Create (or take) the session now and open it; paint the first prompt from
 * the preview store from the session page's first frame; and hold the prompt
 * POST behind unfinished uploads — the create cannot carry a prompt whose
 * upload handles do not exist yet. The held POST survives the navigation
 * (keyed by the created session, stamped with the Send time so a message sent
 * on the session page meanwhile still follows it) and words its failures in
 * the caller's locale. A refused create rejects so the composer restores its
 * draft; the connector gate's Retry re-creates with the same options and the
 * held POST leaves from the navigation callback.
 */
export async function deliverHeldFirstPrompt(input: {
  projectId: string;
  text: string;
  files: AttachedFile[] | undefined;
  options: ProjectHomeSendOptions | undefined;
  attachments: AttachmentSubmission | undefined;
  newSession: (opts: NewProjectSessionOpts) => void;
  setSending: (sending: boolean) => void;
  tI18nComplete: UiTranslator;
  tComposerAttachments: (key: (typeof SENT_FAILURE_COPY)[AttachmentFailureReason]) => string;
}): Promise<void> {
  const { projectId, text, files, options, attachments, newSession, setSending } = input;
  const { tI18nComplete, tComposerAttachments } = input;
  // Identical create-first path to every other new-session entry point: the
  // composer shows a sending spinner for the create RTT (~one round trip),
  // then navigates into the instant shell, which auto-sends `text` once the
  // box is ready. No server-side initial_prompt — the shell shows the
  // message + inline boot status, matching the global dashboard composer.
  // Bind the chosen agent at session birth so `project_sessions.agent_name`
  // is honest from turn one: the grant re-mint and connector authz resolve
  // against that name, so an unbound session would mint the wrong agent's
  // tokens for the first prompt (see buildNewSessionCreateInput). The proxy
  // no longer refuses a prompt whose agent differs — switching is allowed.
  setSending(true);
  // Send time, not POST time. A held POST lands after the uploads, and the
  // server orders rows by this stamp: a message sent on the session page
  // meanwhile must still follow this one.
  const sentAtMs = Date.now();
  // Uploads still running at Send never hold the paint. The session is
  // created (or the warm one taken) and opened now, and the first-prompt
  // preview draws the message. Only the prompt POST waits for the uploads:
  // the create cannot carry a prompt whose upload handles do not exist yet.
  // Uploads already finished keep the create carrying the prompt.
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
  // Keyed by the created session: a send made on the session page meanwhile
  // queues behind this POST. It starts at most once per Send.
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
  // rejected, so nothing after the `await` runs, and the composer has taken
  // the uploads back, so its unmount would delete them.
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
        // `sessionId` here is the route/Kortix session id, not the OpenCode
        // pin the session page resolves later (`useCanonicalRuntimeSession`
        // /`ensureOpencodeSessionPin` mint a separate id). Stash under the
        // route id via the SDK's canonical `writeStartStash` — the session
        // page's `migrateStash` hands this off onto the resolved pin once it
        // exists, and `readStartStash` (instant shell, `useSession`) reads it
        // uniformly either side of that migration.
        // PICKS only: the prompt (and its attachments) are already a
        // durable inbox row via create.pending_prompt above — a prompt in
        // the stash here would be a second delivery channel for the same
        // message.
        writeStartStash(sessionId, {
          prompt: '',
          agent: options?.agent ?? null,
          model: options?.model ?? null,
          variant: options?.variant ?? null,
        });
        // RENDER-only copy for the boot shell, so the bubble is on screen
        // from the session page's first frame — see `useFirstPromptPreviewStore`.
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
}
