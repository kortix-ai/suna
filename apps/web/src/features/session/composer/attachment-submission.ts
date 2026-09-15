import type { PromptAttachmentItem, SessionPromptPart } from '@kortix/sdk';

import { adoptSentAttachmentPreviews } from '../sent-attachment-previews';
import type { AttachmentUploadStatus } from '../turn/user-message';
import { deliverInOrder, deliveryPending } from './delivery-chain';
import { holdUntilSent } from './held-send-guard';
import type { AttachedFile } from './types';

/** The controller surface one Send uses. `usePromptAttachments` satisfies it. */
export interface AttachmentSubmissionController {
  readonly attachments: readonly PromptAttachmentItem[];
  submit: (ids: readonly string[]) => void;
  retry: (id: string) => void;
  forget: (ids: readonly string[]) => void;
  reclaim: (ids: readonly string[]) => void;
  whenReady: (
    ids: readonly string[],
    options?: { signal?: AbortSignal },
  ) => Promise<SessionPromptPart[]>;
}

/**
 * One Send's handed-off uploads. The host paints, then awaits `whenReady`
 * before its POST, and releases the uploads once the POST is accepted.
 */
export interface AttachmentSubmission {
  readonly submittedIds: readonly string[];
  /** Every selected upload was ready at Send, so `whenReady` resolves at once. */
  readonly readyAtSend: boolean;
  whenReady: (options?: { signal?: AbortSignal }) => Promise<SessionPromptPart[]>;
  /** Restart this send's failed uploads with the same File and `attachment_id`. */
  retry: () => void;
  /** Release this send's uploads after its prompt POST is accepted. */
  release: () => void;
}

export interface StageComposerFilesDependencies {
  addMany: (files: readonly File[]) => string[];
  createObjectURL: (file: File) => string;
  isImage: (file: File) => boolean;
}

/** Validate and start every upload before creating preview URLs or React state. */
export function stageComposerFiles(
  files: readonly File[],
  dependencies: StageComposerFilesDependencies,
): Extract<AttachedFile, { kind: 'local' }>[] {
  if (files.length === 0) return [];
  const ids = dependencies.addMany(files);
  if (ids.length !== files.length) throw new Error('Attachment upload batch was not accepted');
  const attachedAt = Date.now();
  return files.map((file, index) => ({
    kind: 'local',
    uploadId: ids[index]!,
    attachedAt,
    file,
    localUrl: dependencies.createObjectURL(file),
    isImage: dependencies.isImage(file),
  }));
}

export function attachedFileUploadId(file: AttachedFile): string | undefined {
  return file.kind === 'local' ? file.uploadId : undefined;
}

/** Resources owned only by a replaced composer tray. Active submissions keep ownership. */
export function planAttachmentReplacement(
  current: readonly AttachedFile[],
  next: readonly AttachedFile[],
  protectedIds: ReadonlySet<string>,
): { idsToRemove: string[]; urlsToRevoke: string[] } {
  const retained = new Set<string>();
  for (const file of next) {
    const uploadId = attachedFileUploadId(file);
    if (uploadId) retained.add(uploadId);
  }
  const idsToRemove: string[] = [];
  const urlsToRevoke: string[] = [];
  for (const file of current) {
    const uploadId = attachedFileUploadId(file);
    if (!uploadId || retained.has(uploadId) || protectedIds.has(uploadId)) continue;
    idsToRemove.push(uploadId);
    if (file.kind === 'local') urlsToRevoke.push(file.localUrl);
  }
  return { idsToRemove, urlsToRevoke };
}

/** A failed upload refuses Send. Pending, uploading, and processing uploads never do. */
export function attachmentsBlockSend(
  items: readonly Pick<PromptAttachmentItem, 'status'>[],
): boolean {
  return items.some((item) => item.status === 'error' || item.status === 'aborted');
}

/**
 * Why an upload or a painted send failed, in the terms the UI words and acts on.
 * `connection` is every failure the same File can recover from on Retry.
 */
export type AttachmentFailureReason = 'billing' | 'budget' | 'tooLarge' | 'expired' | 'connection';

export function attachmentFailureReason(error: unknown): AttachmentFailureReason {
  // Read by field, not `instanceof`: a page can hold two copies of the SDK error classes.
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (status === 402) return 'billing';
  if (code === 'attachment_budget_exceeded') return 'budget';
  if (status === 413 || code === 'attachment_size_limit' || code === 'attachment_message_limit')
    return 'tooLarge';
  if (code === 'attachment_expired' || code === 'attachment_not_found') return 'expired';
  return 'connection';
}

/** Retry sends the same File again. A refusal (billing, budget, size, expiry) answers the same way. */
export function attachmentFailureRetryable(reason: AttachmentFailureReason): boolean {
  return reason === 'connection';
}

/**
 * The `hardcodedUi.composerAttachments` line under "Couldn't send" for each reason. A sent
 * message never says "Upload failed": upload state belongs to the composer tile.
 */
export const SENT_FAILURE_COPY = {
  billing: 'billingRequired',
  budget: 'budgetExceeded',
  tooLarge: 'tooLarge',
  expired: 'expired',
  connection: 'checkConnection',
} as const satisfies Record<AttachmentFailureReason, string>;

/**
 * Billing refusals among `items` that `seen` has not recorded yet. The composer opens the
 * plan dialog for them once; a failed tile stays in later snapshots without a second dialog.
 */
export function takeNewBillingRefusals(
  items: readonly Pick<PromptAttachmentItem, 'status' | 'error'>[],
  seen: WeakSet<object>,
): Error[] {
  const refusals: Error[] = [];
  for (const item of items) {
    const { error } = item;
    if (item.status !== 'error' || !error || seen.has(error)) continue;
    if (attachmentFailureReason(error) !== 'billing') continue;
    seen.add(error);
    refusals.push(error);
  }
  return refusals;
}

const NO_UPLOADS: AttachmentSubmission = {
  submittedIds: [],
  readyAtSend: true,
  whenReady: async () => [],
  retry: () => {},
  release: () => {},
};

/**
 * Hand one Send's selected uploads to its host, synchronously.
 *
 * Send never waits for an upload: the selection is handed off and the host is
 * called in the same tick. Returns `null`, handing nothing off, only when a
 * selected upload failed. The Send control states that reason, so no toast.
 */
export function captureAttachmentSubmission(
  files: readonly AttachedFile[],
  controller: AttachmentSubmissionController,
  holdUnload: <T>(work: Promise<T>) => Promise<T> = holdUntilSent,
): AttachmentSubmission | null {
  const submittedIds = files.flatMap((file) => attachedFileUploadId(file) ?? []);
  if (submittedIds.length === 0) return NO_UPLOADS;
  const selected = new Set(submittedIds);
  if (attachmentsBlockSend(controller.attachments.filter((item) => selected.has(item.id))))
    return null;
  const readyAtSend = submittedIds.every(
    (id) => controller.attachments.find((item) => item.id === id)?.status === 'ready',
  );
  controller.submit(submittedIds);
  // The sent message draws the composer's pictures from its first frame.
  adoptSentAttachmentPreviews(files);
  return {
    submittedIds,
    readyAtSend,
    whenReady: (options) => holdUnload(controller.whenReady(submittedIds, options)),
    retry: () => {
      for (const id of submittedIds) controller.retry(id);
    },
    release: () => controller.forget(submittedIds),
  };
}

/**
 * One composer Send after capture. The submitted ids stay protected from a
 * tray replacement while the host takes the send. A host that throws refused
 * the send before anything durable happened: the uploads return to the tray
 * and `onFailed` restores the draft. A detached send (one with uploads, or one
 * behind an earlier send of its session) never throws here (`deliverAfterPaint`).
 */
export async function runComposerSend(input: {
  submission: AttachmentSubmission;
  controller: Pick<AttachmentSubmissionController, 'reclaim'>;
  active: Set<string>;
  send: () => unknown;
  onSent: () => void;
  onFailed: () => void;
}): Promise<void> {
  const { submission, controller, active } = input;
  for (const id of submission.submittedIds) active.add(id);
  try {
    await input.send();
    input.onSent();
  } catch {
    controller.reclaim(submission.submittedIds);
    input.onFailed();
  } finally {
    for (const id of submission.submittedIds) active.delete(id);
  }
}

/**
 * Whether a painted send is delivered detached from the composer: it carries
 * uploads, or an earlier send of the same session is still being delivered.
 * A caller with no submission is not the composer, and it always waits.
 */
export function deliversDetached(
  sessionKey: string,
  submission: AttachmentSubmission | undefined,
): boolean {
  return !!submission && (submission.submittedIds.length > 0 || deliveryPending(sessionKey));
}

/**
 * Deliver a send whose message is already painted, in its session's Send order.
 *
 * Every delivery takes its place in the session's chain (`deliverInOrder`), so
 * POSTs leave in Enter order. A detached send (`deliversDetached`) returns
 * `painted` at once: the composer's dispatch settles now, so the next Send
 * paints at once instead of waiting behind an upload or an earlier POST.
 * `deliver` then owns every failure and keeps the message on screen, marked
 * failed with Retry. Any other send waits for `deliver`, so a refusal still
 * returns its draft. `deliver` is told which of the two it is.
 *
 * `immediate` is the one exception, for a send with no uploads: it POSTs at
 * once, outside the chain, takes no place in it, and waits for `deliver`. The
 * inline edit's send uses it. It commits the rewind it staged, so it must not
 * wait behind an earlier send that would commit that rewind first.
 */
export function deliverAfterPaint<T>(
  sessionKey: string,
  submission: AttachmentSubmission | undefined,
  deliver: (detached: boolean) => Promise<T>,
  painted: T,
  options: { immediate?: boolean } = {},
): Promise<T> {
  if (options.immediate) return deliver(false);
  // Read before this send joins the chain.
  const detached = deliversDetached(sessionKey, submission);
  const delivered = deliverInOrder(sessionKey, () => deliver(detached));
  if (!detached) return delivered;
  void delivered.catch((error: unknown) => {
    // `deliver` marks its own failures. Reaching here is a bug in that handling.
    console.error('[attachments] detached send failed without a failed state', error);
  });
  return Promise.resolve(painted);
}

/**
 * Post a painted send once its uploads are ready, then release them.
 *
 * The wait and the POST take the session's next place in its delivery chain
 * at this call, so the POST leaves after every earlier send of the session. A
 * painted message is never taken back. When an upload or the POST fails,
 * `onStatus` receives a failed status for the message, worded by `describe`,
 * and the chain moves on. Its Retry restarts the failed uploads at once
 * (finished uploads are not sent again) and posts again from the chain's tail.
 */
export async function postWhenUploaded(
  sessionKey: string,
  submission: AttachmentSubmission,
  post: (parts: SessionPromptPart[]) => Promise<unknown>,
  onStatus: (status: AttachmentUploadStatus | undefined) => void,
  describe: (error: unknown) => string,
): Promise<void> {
  const attempt = async (retrying: boolean): Promise<void> => {
    try {
      if (retrying) submission.retry();
      await deliverInOrder(sessionKey, async () => post(await submission.whenReady()));
    } catch (error) {
      onStatus({
        state: 'failed',
        message: describe(error),
        onRetry: () => {
          onStatus(undefined);
          void attempt(true);
        },
      });
      return;
    }
    submission.release();
  };
  await attempt(false);
}

/**
 * How one composer dispatch ended. `'sent'`: a host took the draft.
 * `'answered'`: an open question took its text only. Nothing: refused before
 * any host.
 */
export type DispatchOutcome = 'sent' | 'answered' | void;

/**
 * Run one latched dispatch. A stashed draft left the editor and handed its
 * uploads off at Enter. When its dispatch does not reach a host, the uploads
 * return to the tray and `restore` puts the draft back: text and files, or only
 * the files when a question took the text.
 */
export async function dispatchLatched<S extends { attachmentSubmission: AttachmentSubmission }>(
  stash: S | undefined,
  dispatch: (stash?: S) => Promise<DispatchOutcome>,
  controller: Pick<AttachmentSubmissionController, 'reclaim'>,
  restore: (stash: S, withText: boolean) => void,
): Promise<void> {
  const outcome = await dispatch(stash);
  if (!stash || outcome === 'sent') return;
  controller.reclaim(stash.attachmentSubmission.submittedIds);
  restore(stash, outcome !== 'answered');
}
