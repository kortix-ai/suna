/**
 * Client half of platform-admin act-as impersonation.
 *
 * The client holds an ID, never a capability. `X-Kortix-Impersonate: <grantId>`
 * is only meaningful next to the operator's own Supabase JWT, and the API
 * re-validates ownership, expiry, revocation and the operator's CURRENT
 * platform role on every request (see apps/api/src/shared/impersonation.ts).
 * So nothing here is a security boundary — losing this value to another tab or
 * another user grants them nothing. What this module owes the user is honesty:
 * while a session is stored, EVERY request carries the header, and the app
 * shell shows the banner that says so.
 *
 * Persisted in `sessionStorage`, not `localStorage`: acting as an account is
 * per-tab and must not outlive the tab. `window`/`sessionStorage` are globals,
 * not imports, so every access is guarded — the SDK core has to load in Node,
 * a Worker, and React Native, where neither exists.
 */

/** The request header. Matches `IMPERSONATION_HEADER` in the API. */
export const IMPERSONATION_HEADER = 'X-Kortix-Impersonate';

const STORAGE_KEY = 'kortix.impersonation';

/** What the console stores after minting a grant. */
export interface ImpersonationSession {
  /** `impersonation_grants.id`. The only part sent to the server. */
  grantId: string;
  /** The account being acted as — what the banner names. */
  accountId: string;
  /** Display name, for the banner. Null when the account has none. */
  accountName?: string | null;
  /** ISO-8601 instant the grant dies. The server caps this at one hour. */
  expiresAt: string;
}

let current: ImpersonationSession | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    // Access to storage throws outright in some privacy modes.
    return null;
  }
}

/**
 * A session with no parseable future expiry is NOT a session. Treating an
 * unreadable date as "no expiry" would leave a banner up, and a header
 * attached, forever after one corrupt write.
 */
export function isImpersonationSessionLive(
  session: ImpersonationSession | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!session || !session.grantId || !session.accountId) return false;
  const expiry = Date.parse(session.expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

function parse(raw: string | null): ImpersonationSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImpersonationSession>;
    if (typeof parsed?.grantId !== 'string' || typeof parsed?.accountId !== 'string') return null;
    return {
      grantId: parsed.grantId,
      accountId: parsed.accountId,
      accountName: typeof parsed.accountName === 'string' ? parsed.accountName : null,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '',
    };
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others, and must never break the
      // request that triggered the change.
    }
  }
}

/**
 * The live session, or null. Reads through to `sessionStorage` once per JS
 * context so a full page navigation (admin console → app shell) keeps acting
 * as the account, then serves the in-memory mirror.
 *
 * An expired session is DROPPED here — the store never hands back a value the
 * server would 403 — and dropping it notifies subscribers, so the banner
 * disappears on its own when the hour is up.
 */
export function getImpersonationSession(): ImpersonationSession | null {
  if (!hydrated) {
    hydrated = true;
    current = parse(storage()?.getItem(STORAGE_KEY) ?? null);
  }
  if (current && !isImpersonationSessionLive(current)) {
    clearImpersonationSession();
    return null;
  }
  return current;
}

export function setImpersonationSession(session: ImpersonationSession | null): void {
  hydrated = true;
  if (!session) {
    clearImpersonationSession();
    return;
  }
  current = session;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Quota or privacy mode. The in-memory mirror still works for this tab's
    // lifetime; only reload-survival is lost.
  }
  notify();
}

export function clearImpersonationSession(): void {
  hydrated = true;
  const had = current !== null;
  current = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* see setImpersonationSession */
  }
  if (had) notify();
}

/** Subscribe to session changes (the banner's data source). Returns an unsubscribe. */
export function subscribeToImpersonation(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The admin console is the ONE surface that is never impersonated.
 *
 * The server refuses an impersonated `/v1/admin/*` request outright — no
 * nesting, no minting a second grant, no changing platform roles from inside a
 * customer's context. The revoke route lives under that same prefix, so a
 * client that attached the header everywhere would 403 its own Exit button and
 * strand the operator until the grant expired.
 *
 * Skipping it here is UX, not a security decision: the server's denial is the
 * control, and it still fires for any client that does send the header.
 *
 * Matched on `admin/` FOLLOWED BY one of the console's two sub-routers, not on
 * the bare word: every admin route is `/admin/api/…` or `/admin/analytics/…`,
 * while `/projects/admin/sessions` is an ordinary product path for a project
 * that happens to be called "admin". Anchoring on the pair keeps a
 * customer-controlled name from silently exempting itself, and keeps working
 * when the backend URL carries a path prefix of its own.
 */
const ADMIN_CONSOLE_PATH_RE = /(^|\/)admin\/(api|analytics)(\/|$)/;

export function shouldAttachImpersonation(url: string): boolean {
  let path = url;
  if (/^https?:\/\//.test(url)) {
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }
  }
  return !ADMIN_CONSOLE_PATH_RE.test(path);
}

/**
 * Headers a platform request adds while acting as an account. `{}` when there
 * is no live session, so the ordinary path allocates one empty object and
 * touches nothing else.
 */
export function impersonationHeaders(url?: string): Record<string, string> {
  if (url !== undefined && !shouldAttachImpersonation(url)) return {};
  const session = getImpersonationSession();
  return session ? { [IMPERSONATION_HEADER]: session.grantId } : {};
}
