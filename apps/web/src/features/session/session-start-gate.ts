/**
 * May the `/start` poll run for this session?
 *
 * The billing check is a PRE-flight condition that was being evaluated as a
 * running one — and it flips. `projectAccountId` arrives with `project-detail`,
 * a full round-trip before the account state it scopes, so the old gate read
 * open → shut → open on every session open:
 *
 *   mount          projectAccountId undefined  → gate open  → /start fires
 *   detail lands   accountId known, state not  → gate SHUT  → /start disabled
 *   state lands    account known good          → gate open  → /start resumes
 *
 * That middle beat disabled an in-flight `/start` long-poll mid-wake, stalling
 * exactly the sessions that take longest to boot. Note the first row: the
 * optimistic start already happened before the gate could shut, so the shut
 * never prevented a request — it only interrupted one.
 *
 * Monotonic instead: poll until we positively learn the account is blocked, and
 * once blocked stay blocked. Entitlement is enforced server-side regardless;
 * this gate exists only to stop pointlessly polling for a sandbox that will
 * never be provisioned.
 */
export function canPollSessionStart(input: {
  hasUser: boolean;
  /** True only once account state has loaded AND says this account cannot run. */
  billingBlocked: boolean;
}): boolean {
  return input.hasUser && !input.billingBlocked;
}
