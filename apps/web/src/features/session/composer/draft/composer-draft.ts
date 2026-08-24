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
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; sessionId: string };

/**
 * The only attachment shape that can cross a reload. A `local` AttachedFile
 * holds a live `File` and a blob object URL: the `File` is not JSON, and the
 * blob URL is revoked the moment the document unloads. Storing either would
 * restore an attachment chip pointing at nothing.
 */
export type RemoteAttachedFile = Extract<AttachedFile, { kind: 'remote' }>;

/** Bumped whenever `StoredDraft`'s shape changes. Old drafts then read as misses. */
export const DRAFT_ENVELOPE_VERSION = 1;

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
   * Sign-out is called from three places and two of them
   * (`features/layout/user-menu-shared.tsx`, `features/workspace/command-palette.tsx`)
   * call `supabase.auth.signOut()` directly rather than through
   * `features/providers/auth-provider.tsx`. A "clear drafts on sign-out" hook
   * wired to one would silently miss the others, and would miss token expiry
   * entirely. Checking the author on every READ covers all of them with no
   * sign-out wiring at all. This matters because project access is shared: two
   * teammates on one machine can both legitimately open the same project route.
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
  userId: string;
}): StoredDraft | null {
  if (!input.userId) return null;
  const files = input.files.filter(isRemote);
  if (input.documentIsEmpty && files.length === 0) return null;
  const draft: StoredDraft = {
    v: DRAFT_ENVELOPE_VERSION,
    u: input.userId,
    doc: input.doc,
    files,
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
  return {
    v: candidate.v,
    u: candidate.u,
    doc: candidate.doc,
    files: candidate.files.filter(isRemote),
  };
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
