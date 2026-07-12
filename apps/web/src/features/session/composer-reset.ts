import type { AttachedFile } from './session-chat-input';

/**
 * On send, decide whether the composer resets in place and which local object
 * URLs to revoke.
 *
 * When `clearOnSend` is false the send navigates the composer away (project home
 * → new session): the composer must NOT clear its text or revoke the local file
 * URLs. The message and its attachments are handed to the freshly created
 * session (via the start-stash + pending-files store) and would otherwise be
 * wiped mid-navigation — and revoking the local URLs would break the instant
 * shell's attachment previews. When true (every in-thread composer, which stays
 * mounted), reset in place and revoke the local object URLs that are no longer
 * referenced.
 *
 * Extracted from `SessionChatInput.handleSubmit` so the decision — and, crucially,
 * *which* URLs get revoked — is unit-testable without a DOM harness.
 */
export function resolveComposerResetOnSend(
  clearOnSend: boolean,
  attachedFiles: readonly AttachedFile[],
): { clear: boolean; urlsToRevoke: string[] } {
  if (!clearOnSend) return { clear: false, urlsToRevoke: [] };
  return {
    clear: true,
    urlsToRevoke: attachedFiles
      .filter((f): f is Extract<AttachedFile, { kind: 'local' }> => f.kind === 'local')
      .map((f) => f.localUrl),
  };
}
