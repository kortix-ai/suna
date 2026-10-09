// Reading the notification inbox (KRTX-1742). STUB(KRTX-1742 WP-T): replaced
// by the routes work package. The digest (notification worker) reuses
// `filterVisibleNotificationRows`, so the bell and the email apply one rule.

export interface InboxRowForFilter {
  notificationId: string;
  userId: string;
  accountId: string;
  projectId: string | null;
  sessionId: string | null;
  triggerSlug: string | null;
  kind: string;
}

export interface InboxReadContext {
  /** The caller's IAM token id; null for a browser sign-in. */
  iamTokenId?: string | null;
  /** The caller's assurance level; undefined in background jobs (digest). */
  mfaAal?: string | null;
  /** Background jobs (digest) skip the MFA step-up: an email is not a sign-in. */
  skipMfaGate?: boolean;
}

/**
 * The rows `userId` may still see: the account's MFA step-up (unless skipped),
 * session rows through `maySeeSessions`, trigger rows through
 * `mayReadProjectTriggers`. Order preserved.
 */
export async function filterVisibleNotificationRows<T extends InboxRowForFilter>(
  _userId: string,
  rows: readonly T[],
  _ctx: InboxReadContext = {},
): Promise<T[]> {
  return [...rows];
}
