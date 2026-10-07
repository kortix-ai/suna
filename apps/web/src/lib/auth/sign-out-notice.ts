/**
 * Carry "the server sign-out did not complete" across the sign-out's own
 * document load.
 *
 * `runSignOut` ends on a DOCUMENT navigation to `/auth` (`performSignOut`),
 * and a navigation discards this document's React tree — every toast raised
 * here dies before anyone can read it. The notice is therefore stashed in
 * THIS tab's `sessionStorage` and raised by the `/auth` screen on mount.
 *
 * `sessionStorage`, not `localStorage`: the notice belongs to the tab that
 * just failed to sign out, and must never surface for another tab or another
 * user. The key sits under the `kortix-` prefix (`APP_STORAGE_PREFIXES`), so
 * the sign-out sweep owns it; the sequence writes it AFTER that sweep
 * (`sign-out-sequence.ts` calls the notify step between `resetClientState`
 * and `leave`), which is what lets it survive to the next document.
 *
 * The value carries no copy on purpose: the message is user-facing text and
 * lives in the translations, raised where the locale is known (`AuthContent`).
 */

const SIGN_OUT_NOTICE_KEY = 'kortix-sign-out-notice';

/** Remember, for the next document in this tab, that the sign-out did not complete. */
export function stashSignOutNotice(): void {
  try {
    sessionStorage.setItem(SIGN_OUT_NOTICE_KEY, '1');
  } catch {
    // Safari private mode and partitioned iframes can refuse storage access.
    // A notice that cannot be stashed is the pre-fix behaviour; the sign-out
    // itself is unaffected.
  }
}

/** Read-and-clear the notice. True at most once per failed sign-out in this tab. */
export function takeSignOutNotice(): boolean {
  try {
    const present = sessionStorage.getItem(SIGN_OUT_NOTICE_KEY) !== null;
    sessionStorage.removeItem(SIGN_OUT_NOTICE_KEY);
    return present;
  } catch {
    return false;
  }
}
