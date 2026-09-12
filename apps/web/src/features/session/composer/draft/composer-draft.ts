import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENT_FILES,
  MAX_PROMPT_ATTACHMENTS_BYTES,
  type PromptAttachment,
} from '@kortix/sdk';
import type { JSONContent } from '@tiptap/core';

import type { AttachedFile } from '../types';

/**
 * What a persisted composer draft is keyed by.
 *
 * Project scope is the home hero composer — one draft per project, because
 * that composer has no session yet. Session scope is every in-thread composer.
 * Both ids are UUIDs, so the two families can never collide.
 */
export type DraftScope =
  { kind: 'project'; projectId: string } | { kind: 'session'; sessionId: string };

/**
 * The only attachment shape that can cross a reload. A `local` AttachedFile
 * holds a live `File` and a blob object URL: the `File` is not JSON, and the
 * blob URL is revoked the moment the document unloads. Storing either would
 * restore an attachment chip pointing at nothing.
 */
export type RemoteAttachedFile = Extract<AttachedFile, { kind: 'remote' }>;

/** In-memory association; serialization strips the controller's local identity. */
export type CompletedDraftAttachment = PromptAttachment & { uploadId: string };

/** Bumped whenever `StoredDraft`'s shape changes. Old drafts then read as misses. */
export const DRAFT_ENVELOPE_VERSION = 3;

export type DraftAttachmentOrderEntry =
  { kind: 'remote'; index: number } | { kind: 'attachment'; attachmentId: string };

/**
 * Per-draft ceiling, bytes of serialized JSON. The whole origin shares one
 * ~5-10MB localStorage bucket (see `lib/storage/managed-storage.ts`), so one
 * pasted logfile must not be able to consume it. Enforced here rather than in
 * the store so it is testable without storage.
 */
export const MAX_DRAFT_BYTES = 131072;

export interface StoredDraft {
  /** Envelope version — see DRAFT_ENVELOPE_VERSION. */
  v: number;
  /**
   * Supabase user id of the author.
   *
   * Sign-out is one call now (`lib/auth/perform-sign-out.ts`), but a "clear
   * drafts on sign-out" hook wired to it would still miss token expiry, which
   * ends a session without any logout control being pressed. Checking the
   * author on every READ covers both with no sign-out wiring at all. This
   * matters because project access is shared: two teammates on one machine can
   * both legitimately open the same project route.
   */
  u: string;
  /**
   * The ProseMirror document, mention atoms intact. NOT a string:
   * `ComposerEditorHandle.setContent(text)` only ever builds plain paragraphs,
   * so a text round trip flattens every chip to literal "@label" and the next
   * send emits no `<file_ref>`/`<agent_ref>`/`<session_ref>` block.
   */
  doc: JSONContent;
  files: RemoteAttachedFile[];
  /** Completed private handles only. No file bytes, blob URLs, or signed URLs. */
  attachments: PromptAttachment[];
  /** Original mixed tray order, expressed only through safe stored metadata. */
  order: DraftAttachmentOrderEntry[];
}

/** The `<kind>:<id>` half of the storage key. The family prefix is the store's. */
export function draftScopeKey(scope: DraftScope): string {
  return scope.kind === 'project' ? `project:${scope.projectId}` : `session:${scope.sessionId}`;
}

const isRemote = (file: AttachedFile): file is RemoteAttachedFile => file.kind === 'remote';

/**
 * Build the envelope to store, or `null` for "there is nothing worth keeping —
 * remove the key". `null` has exactly one meaning throughout the feature, which
 * is what lets an emptied editor delete its own draft through the same path
 * that writes one.
 *
 * `documentIsEmpty` is supplied by the caller, never re-derived from `doc`.
 * The canonical definition of empty for a TipTap document is `editor.isEmpty`,
 * and the caller holds a live `ComposerEditorHandle.isEmpty()`. Re-implementing
 * it here would risk drifting from it — the same reasoning
 * `composer-draft-recovery.ts` records for `mergeFailedSubmissionDocument`.
 */
export function serializeDraft(input: {
  doc: JSONContent;
  documentIsEmpty: boolean;
  files: readonly AttachedFile[];
  attachments?: readonly CompletedDraftAttachment[];
  userId: string;
}): StoredDraft | null {
  if (!input.userId) return null;
  const attachments = safeAttachments(input.attachments ?? []);
  const files: RemoteAttachedFile[] = [];
  const unusedAttachments = new Set(attachments.map((attachment) => attachment.attachment_id));
  const attachmentsById = new Map(
    attachments.map((attachment) => [attachment.attachment_id, attachment]),
  );
  const attachmentsByUploadId = new Map(
    (input.attachments ?? []).map((attachment) => [
      attachment.uploadId,
      attachmentsById.get(attachment.attachment_id),
    ]),
  );
  const order: DraftAttachmentOrderEntry[] = [];
  for (const file of input.files) {
    if (file.kind === 'remote') {
      order.push({ kind: 'remote', index: files.push(file) - 1 });
      continue;
    }
    let attachment: PromptAttachment | undefined;
    if (file.kind === 'staged') {
      attachment = attachmentsById.get(file.attachment.attachment_id);
    } else {
      attachment = attachmentsByUploadId.get(file.uploadId);
    }
    if (attachment) {
      unusedAttachments.delete(attachment.attachment_id);
      order.push({ kind: 'attachment', attachmentId: attachment.attachment_id });
    }
  }
  for (const attachment of attachments) {
    if (unusedAttachments.has(attachment.attachment_id)) {
      order.push({ kind: 'attachment', attachmentId: attachment.attachment_id });
    }
  }
  if (input.documentIsEmpty && files.length === 0 && attachments.length === 0) return null;
  const draft: StoredDraft = {
    v: DRAFT_ENVELOPE_VERSION,
    u: input.userId,
    doc: input.doc,
    files,
    attachments,
    order,
  };
  if (JSON.stringify(draft).length > MAX_DRAFT_BYTES) return null;
  return draft;
}

/**
 * Validate a value read back out of storage. Returns `null` — never throws and
 * never partially trusts — on a version mismatch, a malformed payload, or a
 * draft written by a different user.
 */
export function deserializeDraft(raw: unknown, currentUserId: string): StoredDraft | null {
  if (!currentUserId) return null;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<StoredDraft>;
  if (candidate.v !== DRAFT_ENVELOPE_VERSION) return null;
  if (typeof candidate.u !== 'string' || candidate.u !== currentUserId) return null;
  if (!candidate.doc || typeof candidate.doc !== 'object') return null;
  if (!Array.isArray(candidate.files)) return null;
  if (!Array.isArray(candidate.attachments)) return null;
  if (!Array.isArray(candidate.order)) return null;
  const files = candidate.files.filter(isRemote);
  const attachments = safeAttachments(candidate.attachments);
  const attachmentIds = new Set(attachments.map((attachment) => attachment.attachment_id));
  const order = candidate.order.filter((entry): entry is DraftAttachmentOrderEntry => {
    if (!entry || typeof entry !== 'object') return false;
    const value = entry as Partial<DraftAttachmentOrderEntry> & { index?: unknown };
    return value.kind === 'remote'
      ? Number.isSafeInteger(value.index) &&
          (value.index as number) >= 0 &&
          (value.index as number) < files.length
      : value.kind === 'attachment' &&
          typeof value.attachmentId === 'string' &&
          attachmentIds.has(value.attachmentId);
  });
  return {
    v: candidate.v,
    u: candidate.u,
    doc: candidate.doc,
    files,
    attachments,
    order,
  };
}

/** Rebuild the tray from safe descriptors without grouping it by storage kind. */
export function restoreDraftFileOrder(
  draft: StoredDraft,
  restoreAttachment: (attachment: PromptAttachment) => AttachedFile,
): AttachedFile[] {
  const attachments = new Map(
    draft.attachments.map((attachment) => [attachment.attachment_id, attachment]),
  );
  const staged = new Map<string, AttachedFile>();
  const restored: AttachedFile[] = [];
  for (const entry of draft.order) {
    if (entry.kind === 'remote') {
      const file = draft.files[entry.index];
      if (file) restored.push(file);
      continue;
    }
    let file = staged.get(entry.attachmentId);
    if (!file) {
      const attachment = attachments.get(entry.attachmentId);
      if (!attachment) continue;
      file = restoreAttachment(attachment);
      staged.set(entry.attachmentId, file);
    }
    restored.push(file);
  }
  return restored;
}

function safeAttachment(value: unknown): PromptAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<PromptAttachment>;
  if (
    typeof candidate.attachment_id !== 'string' ||
    !candidate.attachment_id ||
    typeof candidate.filename !== 'string' ||
    !candidate.filename ||
    typeof candidate.mime !== 'string' ||
    !candidate.mime ||
    !Number.isSafeInteger(candidate.size) ||
    (candidate.size ?? 0) <= 0 ||
    (candidate.size ?? 0) > MAX_PROMPT_ATTACHMENT_BYTES ||
    typeof candidate.expires_at !== 'string' ||
    !Number.isFinite(Date.parse(candidate.expires_at)) ||
    Date.parse(candidate.expires_at) <= Date.now()
  ) {
    return null;
  }
  return {
    attachment_id: candidate.attachment_id,
    filename: candidate.filename,
    mime: candidate.mime,
    size: candidate.size!,
    expires_at: candidate.expires_at,
  };
}

function safeAttachments(values: readonly unknown[]): PromptAttachment[] {
  const attachments: PromptAttachment[] = [];
  for (const value of values) {
    const attachment = safeAttachment(value);
    if (attachment) attachments.push(attachment);
  }
  if (attachments.length > MAX_PROMPT_ATTACHMENT_FILES) return [];
  if (
    attachments.reduce((sum, attachment) => sum + attachment.size, 0) > MAX_PROMPT_ATTACHMENTS_BYTES
  )
    return [];
  return attachments;
}

/**
 * The restore gate. Precedence, highest first: failed-send recovery, then an
 * explicit prefill (`?q=` deep link, onboarding hand-off, command palette,
 * carried draft from the boot shell), then the stored draft. Both higher
 * sources arrive as a `prefill`, so `hasPrefill` is the whole check.
 *
 * `alreadyRestored` makes this once-per-scope: without it, a remount (tab
 * switch, panel toggle) would ghost a draft back into an editor the user had
 * deliberately emptied.
 */
export function shouldRestoreDraft(input: {
  editorReady: boolean;
  editorIsEmpty: boolean;
  hasPrefill: boolean;
  alreadyRestored: boolean;
}): boolean {
  if (!input.editorReady) return false;
  if (input.alreadyRestored) return false;
  if (input.hasPrefill) return false;
  if (!input.editorIsEmpty) return false;
  return true;
}
