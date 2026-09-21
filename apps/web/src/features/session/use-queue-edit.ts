'use client';

import { errorToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { useQueuedDraftStore } from '@/stores/queued-draft-store';
import type { SessionPrompt, SessionPromptPart } from '@kortix/sdk';
import {
  classifyPromptActionError,
  mintSessionWireMessageId,
  type UseSessionPromptsResult,
} from '@kortix/sdk/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  queueRowEditable,
  rebuildEditedPromptText,
  rowForArrowEdit,
  withEditedText,
} from './composer/queue-edit';
import { removeFailureCopyKey, restoreFailureCopyKey } from './queue-action-copy';
import type { QueueRow } from './queue-projection';
import { restoreQueuedMessage, sendNowQueuedMessage } from './queued-message-restore';

type PromptInbox = Pick<UseSessionPromptsResult, 'prompts' | 'remove' | 'enqueue'>;

/** The words of a prompt's text parts, as the wire carries them. */
function wireText(parts: readonly SessionPromptPart[]): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/**
 * The queued-message Edit and Send now controller one session host mounts.
 *
 * Feeds the composer's `queueEdit` / `onQueueEditSave` / `onQueueEditEnd` and
 * the list's `editingId` / `onEdit` / `onSendNow`. Uses only the inbox routes
 * that already exist:
 *
 * - Edit: the row stays queued while the composer holds its words. ✓ removes
 *   it and re-queues the edited message under its own client id and its
 *   original send time, the same re-POST Undo uses (`restoreQueuedMessage`).
 *   The server keeps a send time only inside its ten-minute window, so an
 *   older message re-queues at the end of the list.
 * - Send now: removes the row and re-queues it in the Quick Queue
 *   (`sendNowQueuedMessage`), which runs ahead of the list and steers into
 *   the running response, or ends it if it is streaming text.
 */
export function useQueueEdit(input: {
  sessionId: string;
  rows: readonly QueueRow[];
  promptInbox: PromptInbox;
}) {
  const { sessionId, rows, promptInbox } = input;
  const t = useTranslations('threads');
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [queueEdit, setQueueEdit] = useState<{ id: string; text: string } | null>(null);

  // Read by stable callbacks; written in effects, never during render.
  const rowsRef = useRef(rows);
  const promptsRef = useRef<readonly SessionPrompt[]>(promptInbox.prompts);
  useEffect(() => {
    rowsRef.current = rows;
    promptsRef.current = promptInbox.prompts;
  }, [rows, promptInbox.prompts]);

  const { remove, enqueue } = promptInbox;

  const openEdit = useCallback((promptId: string): boolean => {
    const row = rowsRef.current.find((candidate) => candidate.id === promptId);
    if (!row || !queueRowEditable(row)) return false;
    setQueueEdit({ id: promptId, text: row.text });
    return true;
  }, []);

  /** ↑ in an empty composer: the last editable row. */
  const editLastRow = useCallback((): boolean => {
    const id = rowForArrowEdit(rowsRef.current, true);
    return id ? openEdit(id) : false;
  }, [openEdit]);

  const saveQueueEdit = useCallback(
    async (promptId: string, text: string): Promise<'saved' | 'refused' | 'failed'> => {
      const sentAtMs = promptsRef.current.find((p) => p.prompt_id === promptId)?.client_sent_at_ms;
      let removed;
      try {
        removed = await remove(promptId);
      } catch (error) {
        const kind = classifyPromptActionError(error);
        if (kind === 'gone' || kind === 'already_sent') {
          // It went out (or was removed) while the composer held it: the
          // edited words stay in the composer as a new draft.
          errorToast(t('editAlreadySent'));
          return 'refused';
        }
        errorToast(t('queueActionFailed'));
        return 'failed';
      }
      const parts = withEditedText(
        removed.parts,
        rebuildEditedPromptText(wireText(removed.parts), text),
      );
      try {
        await enqueue({
          ...restoreQueuedMessage({ ...removed, parts }, () => mintSessionWireMessageId(sessionId)),
          ...(typeof sentAtMs === 'number' ? { clientSentAtMs: sentAtMs } : {}),
        });
      } catch {
        // The row is gone and the re-queue failed: the words must not be lost.
        // They stay in the composer, where Send queues them again.
        errorToast(t('queueActionFailed'));
        return 'refused';
      }
      // The list shows this tab's own draft text over the server's.
      useQueuedDraftStore.getState().setText(sessionId, removed.client_message_id, text);
      return 'saved';
    },
    [remove, enqueue, sessionId, t],
  );

  const endQueueEdit = useCallback((promptId: string) => {
    setQueueEdit((current) => (current?.id === promptId ? null : current));
  }, []);

  const sendNow = useCallback(
    (promptId: string) => {
      void (async () => {
        let removed;
        try {
          removed = await remove(promptId);
        } catch (error) {
          const key = removeFailureCopyKey(classifyPromptActionError(error));
          if (key) errorToast(tHardcodedUi.raw(key));
          return;
        }
        try {
          await enqueue(
            sendNowQueuedMessage(removed, () => mintSessionWireMessageId(sessionId), Date.now()),
          );
        } catch (cause) {
          // The row is gone; put it back where it was rather than lose it.
          const key = restoreFailureCopyKey(cause);
          if (key) errorToast(tHardcodedUi.raw(key));
          void enqueue(
            restoreQueuedMessage(removed, () => mintSessionWireMessageId(sessionId)),
          ).catch(() => undefined);
        }
      })();
    },
    [remove, enqueue, sessionId, tHardcodedUi],
  );

  return {
    queueEdit,
    editingId: queueEdit?.id ?? null,
    openEdit,
    editLastRow,
    saveQueueEdit,
    endQueueEdit,
    sendNow,
  };
}
