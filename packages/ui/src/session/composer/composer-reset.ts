import type { AttachedFile } from './session-chat-input';

/**
 * What a composer does to itself on send.
 *
 *  - `true` — every in-thread composer. It stays mounted, so it resets in
 *    place and revokes the local object URLs nobody references any more.
 *  - `'text-only'` — project home. It clears like any other composer, so the
 *    message visibly LEAVES the box, but it revokes nothing: the same local
 *    URLs are what the instant shell draws its attachment previews from a
 *    moment later, on the other side of the navigation.
 *  - `false` — a composer that must keep the submitted draft on screen
 *    untouched. Nothing clears and nothing is revoked.
 *
 * `'text-only'` exists because the two halves of `false` turned out to be
 * separate decisions. Project home held BOTH — text on screen and URLs alive —
 * for one reason (the URLs), and the text half was the visible cost: Enter left
 * the sentence sitting in a locked box under a spinner for the whole create
 * round trip (measured 1165ms end to end on localhost, `POST .../sessions`
 * alone 908ms; longer over a real network), which reads as a send that did not
 * happen. Splitting them lets the box empty at the keypress, like everywhere
 * else in the app, with the previews still intact when the shell takes over.
 */
export type ComposerSendReset = boolean | 'text-only';

/**
 * On send, decide whether the composer resets in place and which local object
 * URLs to revoke.
 *
 * Extracted from `SessionChatInput.handleSubmit` so the decision — and, crucially,
 * *which* URLs get revoked — is unit-testable without a DOM harness.
 */
export function resolveComposerResetOnSend(
  clearOnSend: ComposerSendReset,
  attachedFiles: readonly AttachedFile[],
): { clear: boolean; urlsToRevoke: string[] } {
  if (!clearOnSend) return { clear: false, urlsToRevoke: [] };
  // Cleared, but the bytes behind these URLs are about to be drawn by another
  // surface. Revoking them here is what broke the instant shell's previews.
  if (clearOnSend === 'text-only') return { clear: true, urlsToRevoke: [] };
  return {
    clear: true,
    urlsToRevoke: attachedFiles
      .filter((f): f is Extract<AttachedFile, { kind: 'local' }> => f.kind === 'local')
      .map((f) => f.localUrl),
  };
}
