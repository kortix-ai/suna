/**
 * One project create = one `idempotency_key` (COR-186), web's
 * `create-workspace-key.ts` + `provision-errors.ts` for mobile.
 *
 * `POST /projects/provision` creates the project before it answers. When the
 * answer is lost (a dropped connection, a `java.net` error on Android), the
 * project exists but the app never hears it. A plain retry then creates a
 * second project, or — on the free plan, limit 1 — fails with
 * `project_limit_reached`, and `/new` had no way out. With the same key, the
 * server checks the key BEFORE the quota and hands back the first project.
 *
 * The key identifies the ATTEMPT, not the payload: the same key with another
 * name returns the FIRST project. So the fingerprint is everything that makes
 * a create distinct (account + name), and a success clears it.
 */

/** Longer than the slowest documented provision (~9 min), as on web. */
export const ATTEMPT_KEY_TTL_MS = 60 * 60 * 1000;

/** Backoff for a `409 provision_in_flight` retry, ms — web's `RETRY_DELAY_MS`. */
export const PROVISION_IN_FLIGHT_RETRY_MS = [400, 1_200];

/** Wait before the one automatic retry after a lost response, ms. */
export const LOST_RESPONSE_RETRY_MS = 1_000;

export function attemptFingerprint(accountId: string, name: string): string {
  return `${accountId}:${name.trim()}`;
}

export interface AttemptKeys {
  keyFor: (fingerprint: string, now: number) => string;
  clear: (fingerprint: string) => void;
}

/** In memory for the app's lifetime; a restart mints fresh keys. */
export function createAttemptKeys(mint: () => string): AttemptKeys {
  const attempts = new Map<string, { key: string; mintedAt: number }>();
  return {
    keyFor: (fingerprint, now) => {
      const cached = attempts.get(fingerprint);
      if (cached && now - cached.mintedAt < ATTEMPT_KEY_TTL_MS) return cached.key;
      const key = mint();
      attempts.set(fingerprint, { key, mintedAt: now });
      return key;
    },
    clear: (fingerprint) => {
      attempts.delete(fingerprint);
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '');
}

/** The free plan's project limit (`403 project_limit_reached`). */
export function isProjectLimitError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'project_limit_reached') return true;
  const message = messageOf(err);
  return message.includes('project_limit_reached') || message.includes('Free accounts are limited to');
}

/** An earlier call with the same key is still running: retry with the SAME key. */
export function isProvisionInFlightError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'provision_in_flight') return true;
  const status = (err as { status?: number } | null)?.status;
  return status === 409 && messageOf(err).includes('idempotency_key is in flight');
}

/**
 * No HTTP answer at all: the request may or may not have reached the server.
 * An `ApiError` from a response always carries `status`; a dropped connection,
 * a timeout, or a native `java.net` / `NSURLError` failure does not.
 */
export function isLostResponseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { status?: number }).status;
  return typeof status !== 'number' || status === 0;
}

/** The project `/new` opens when the account is already at its limit: the newest. */
export function newestProject<T extends { created_at: string }>(projects: readonly T[]): T | null {
  let newest: T | null = null;
  for (const project of projects) {
    if (!newest || Date.parse(project.created_at) > Date.parse(newest.created_at)) newest = project;
  }
  return newest;
}
