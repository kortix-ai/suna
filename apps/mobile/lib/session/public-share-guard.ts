/**
 * Guards `SessionPublicShareRows`' "Share link" mint against an API that
 * predates the `transcript` share kind (KRTX-248 follow-up).
 *
 * `createSessionPublicShare(pid, sid, { transcript: true })` asks for a
 * transcript share. An older server ignores the unknown `transcript` field
 * and mints whatever it defaults to instead — a `preview` share (public
 * app-preview link, port 3000) — and still answers 201/200. The response
 * shape looks fine, so nothing throws; only `resource_type` reveals the
 * mismatch. Sharing that URL would hand out an unintended public preview
 * link, and never revoking it leaves that link live forever.
 *
 * Pure: given the share the create call returned, decide whether it is
 * safe to share and whether the caller must revoke it first.
 */

export const NON_TRANSCRIPT_SHARE_MESSAGE = 'Public links need a newer Kortix server.';

export interface PublicShareGuardResult {
  /** True only for a live `transcript` share — safe to open the share sheet with. */
  ok: boolean;
  /** True when the caller must revoke the share it just got back. */
  shouldRevoke: boolean;
  /** One-sentence toast for the `!ok` case; null when `ok`. */
  message: string | null;
}

const OK: PublicShareGuardResult = { ok: true, shouldRevoke: false, message: null };

/**
 * `share` only needs the field this decision reads — callers pass the full
 * `SessionPublicShare` from `@kortix/sdk`.
 */
export function guardTranscriptShare(share: { resource_type: string }): PublicShareGuardResult {
  if (share.resource_type === 'transcript') return OK;
  return { ok: false, shouldRevoke: true, message: NON_TRANSCRIPT_SHARE_MESSAGE };
}
