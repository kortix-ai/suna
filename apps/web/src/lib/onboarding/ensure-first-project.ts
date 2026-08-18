import { type KortixProject, listProjectsForAccount, provisionProject } from '@kortix/sdk';

import { isValidProjectId } from '@/lib/onboarding/landing-destination';
import { hasPostAuthIntent } from '@/lib/onboarding/post-auth-intent';

export type FirstProjectAutoCreateState = {
  activeAccountId: string | null;
  canCreateProjects: boolean;
  autoCreateAttempted: boolean;
  accountsLoading: boolean;
  projectsLoading: boolean;
  projectsError: boolean;
  projectsLoaded: boolean;
  projectCount: number;
  legacyMachinesLoaded: boolean;
  legacyMachineCount: number;
  billingEnabled: boolean;
  accountStateLoading: boolean;
  canRun: boolean;
  suppressedAfterDelete: boolean;
};

/** Name + template for every auto-provisioned first project. */
export const FIRST_PROJECT_NAME = 'My First Project';
export const FIRST_PROJECT_TEMPLATE = 'general-knowledge-worker';

/**
 * Set when the user archives their LAST project. Auto-provisioning is otherwise
 * unconditional, and without this flag deleting your only project would
 * immediately recreate it — the app undoing the action the user just took.
 * Tab-scoped on purpose: the suppression is about *this* deliberate delete, so a
 * later sign-in or a fresh tab provisions again like any other empty account.
 */
const SUPPRESS_AUTO_PROJECT_KEY = 'kortix:suppress-auto-project';

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Private browsing / blocked storage — fall back to "not suppressed".
    return null;
  }
}

export function suppressAutoProjectAfterDelete(): void {
  safeSessionStorage()?.setItem(SUPPRESS_AUTO_PROJECT_KEY, '1');
}

export function isAutoProjectSuppressed(): boolean {
  return safeSessionStorage()?.getItem(SUPPRESS_AUTO_PROJECT_KEY) === '1';
}

export function clearAutoProjectSuppression(): void {
  safeSessionStorage()?.removeItem(SUPPRESS_AUTO_PROJECT_KEY);
}

/**
 * `localStorage` is absent on the server and in tests, and can throw in
 * private mode. Every access to the provision-attempt key goes through here.
 * Read directly off `globalThis`, not `window.localStorage` — this is what
 * lets a test install a fake without a DOM.
 */
function localAttemptStorage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const PROVISION_ATTEMPT_KEY_PREFIX = 'kortix:onboarding-provision-key:';

/**
 * How long a persisted attempt key stays usable, ms.
 *
 * One hour is chosen against the slowest provision this repo documents — a
 * snapshot build of up to ~9 min, on top of the SDK's own 120s per-call
 * timeout (`provisionProject`). At 6x that ceiling the bound can never expire
 * a key while the attempt it identifies could still be committing, which is
 * the only thing it must not do. Anything the user does an hour later is a new
 * decision, not a retry of the same one, and must not replay the old key.
 */
export const PROVISION_ATTEMPT_TTL_MS = 60 * 60 * 1000;

interface ProvisionAttemptRecord {
  key: string;
  mintedAt: number;
}

function randomAttemptToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A stored attempt record → the key it still authorizes, or `null`.
 *
 * `null` for anything that is not a live record of this attempt: absent,
 * unparseable, the pre-TTL bare-string format, or older than
 * {@link PROVISION_ATTEMPT_TTL_MS}. A NEGATIVE age is also rejected — a
 * future `mintedAt` means the clock moved (or the value was edited), and a
 * timestamp that cannot be trusted is no evidence the attempt is still live.
 *
 * Pure, so the expiry rule is unit-tested without a clock or a DOM.
 */
export function liveProvisionAttemptKey(raw: string | null, now: number): string | null {
  if (!raw) return null;
  let parsed: Partial<ProvisionAttemptRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<ProvisionAttemptRecord>;
  } catch {
    return null;
  }
  if (typeof parsed?.key !== 'string' || parsed.key.length === 0) return null;
  if (typeof parsed.mintedAt !== 'number' || !Number.isFinite(parsed.mintedAt)) return null;
  const age = now - parsed.mintedAt;
  if (age < 0 || age >= PROVISION_ATTEMPT_TTL_MS) return null;
  return parsed.key;
}

/**
 * Stable `idempotency_key` for one account's first-project auto-provision
 * attempt.
 *
 * WHY LOCALSTORAGE, NOT A REF OR SESSIONSTORAGE. `autoCreateAttempted`
 * (projects/page.tsx) and `resolving` (start/page.tsx) are per-mount refs —
 * gone on reload. `sessionStorage` (used above for the delete-suppression
 * flag) is per-TAB — gone the instant a second tab, or the OTHER entry point
 * opened in a new tab, attempts the same logical create. `/projects` and
 * `/projects/start` are two independent doors that can both run this exact
 * attempt for the same account, so only storage shared across same-origin
 * tabs (`localStorage`) lets them cooperate with the server's per-(account,
 * key) dedupe in `provision-idempotency.ts`.
 *
 * WHY KEYED BY ACCOUNT. Two accounts open in two tabs must mint independent
 * keys. The server also scopes the dedupe lookup by `account_id`, so a shared
 * key would be harmless there — but there's no reason to share it.
 *
 * WHY IT MUST NOT OUTLIVE THE ATTEMPT. `findIdempotentProvision` on the
 * server is intentionally NOT scoped to active projects — an archived row
 * still blocks the unique index (see provision-idempotency.ts's doc comment).
 * If this key survived past a successful create, a LATER, genuinely
 * different attempt for the same account (e.g. the user deletes their only
 * project and a fresh auto-create fires) would replay it and get back the
 * archived project instead of creating a new one.
 *
 * TWO BOUNDS, because one is not enough. `clearProvisionAttemptKey` drops the
 * key the moment `ensureFirstProject` resolves — but that function is only
 * reached from `/projects/start`, and from `/projects` when the account has
 * zero projects. So a provision that COMMITS server-side while every client
 * attempt errors (a 120s SDK timeout, then the retry budget exhausted, then
 * the "We could not open your project" screen) leaves the key behind with no
 * caller left to clear it: the user clicks "View all projects", the project is
 * now there, and nothing calls `ensureFirstProject` again. That stale key is
 * exactly what would later replay onto the ARCHIVED project. The second bound
 * is time — see {@link PROVISION_ATTEMPT_TTL_MS} — and it is what makes the
 * guarantee unconditional: a key is reused only within one hour of being
 * minted, cleared or not.
 */
export function getOrCreateProvisionAttemptKey(accountId: string, now = Date.now()): string {
  const store = localAttemptStorage();
  if (store) {
    try {
      const storageKey = `${PROVISION_ATTEMPT_KEY_PREFIX}${accountId}`;
      const existing = liveProvisionAttemptKey(store.getItem(storageKey), now);
      if (existing) return existing;
      const minted = `onboarding-first-project:${randomAttemptToken()}`;
      store.setItem(storageKey, JSON.stringify({ key: minted, mintedAt: now }));
      return minted;
    } catch {
      // Fall through — storage exists but is unusable (quota, blocked write).
    }
  }
  // No usable storage: mint an unpersisted key. A reload loses it — no worse
  // than before this change — but the server-side dedupe still protects the
  // case where storage IS present, which is the common case in a browser.
  return `onboarding-first-project:${randomAttemptToken()}`;
}

/**
 * Drop the persisted attempt key for this account. Called the moment
 * `ensureFirstProject` resolves to a project — by definition the attempt this
 * key identified is over, and keeping it around only risks the stale-replay
 * problem documented on `getOrCreateProvisionAttemptKey`.
 *
 * This is the FAST bound, not the only one. Every path that never reaches a
 * resolution (see the same doc comment) is bounded instead by
 * {@link PROVISION_ATTEMPT_TTL_MS}.
 */
export function clearProvisionAttemptKey(accountId: string): void {
  try {
    localAttemptStorage()?.removeItem(`${PROVISION_ATTEMPT_KEY_PREFIX}${accountId}`);
  } catch {
    // Best-effort cleanup only — an unreadable/unwritable store already fell
    // through to an unpersisted key above, so there is nothing to remove.
  }
}

/**
 * Whether this navigation may CREATE a project, as opposed to only opening one
 * that already exists.
 *
 * Provisioning mints a real managed git repository, so a cross-site link must
 * not trigger it just because the visitor happens to be signed in (CWE-352).
 * Both auto-provisioning entry points — the landing door and the empty projects
 * list — gate creation on this. Opening an EXISTING project stays allowed from
 * anywhere.
 *
 * Intent is proven by any ONE of:
 *  - the post-auth marker — authentication completed moments ago on this
 *    browser. This is what admits every real signup: a magic link opened from
 *    webmail, an OAuth/SSO hop, and the `/auth` page's client-side redirect
 *    all arrive with a CROSS-origin (or stale) `document.referrer`, and a
 *    referrer-only version of this gate demoted exactly those users to the
 *    projects list instead of their project.
 *  - a same-origin referrer — `/`, in-app links.
 *  - an EMPTY referrer — a typed URL or a bookmark.
 * A referrer naming another origin, with no fresh sign-in, is what we refuse.
 *
 * This is defense in depth, not a complete control: an attacker can send
 * `referrerpolicy="no-referrer"` and be indistinguishable from a typed
 * navigation. What bounds the residual risk is that creation only ever fires
 * for an account with ZERO projects, and the free tier caps such an account at
 * one project anyway — so the worst case is the user getting the project that
 * sign-up would have created for them regardless.
 */
export function navigationMayCreateProject(): boolean {
  if (typeof document === 'undefined') return false;
  if (hasPostAuthIntent()) return true;
  const referrer = document.referrer;
  if (!referrer) return true;
  try {
    return new URL(referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

export function isProjectLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('project_limit_reached') || message.includes('Free accounts are limited to')
  );
}

/**
 * True for the 503 `POST /projects/provision` returns when no managed-git
 * backend is configured (e.g. self-host with no MANAGED_GIT_* set) — an
 * EXPECTED, operator-fixable state, not a bug. Checks the status code first
 * (ApiError carries `.status`) and falls back to the message text for any
 * caller that only has a plain Error.
 */
export function isManagedGitUnavailableError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 503) return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('is not configured on this server');
}

/**
 * True for the `409` `POST /projects/provision` returns when another call
 * carrying the SAME `idempotency_key` is mid-provision — see
 * `apps/api/src/projects/lib/provision-idempotency.ts`'s `in_flight` case.
 * This is a RETRYABLE state, not a terminal failure: the concurrent call's
 * outcome just isn't decided yet. Checks `code` first — the precise signal
 * the route sends — and falls back to the message for a caller that only has
 * a plain `Error` (matching `isManagedGitUnavailableError`'s pattern), scoped
 * to `409` so an unrelated conflict is never misread as this one.
 */
export function isProvisionInFlightError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  // The literal, not `PROVISION_IN_FLIGHT_CODE` from `@kortix/sdk`: this
  // module's own test suite replaces `@kortix/sdk` wholesale via `mock.module`,
  // so an imported constant would read back `undefined` there and make every
  // code-less error match. Kept in sync with the SDK constant by name.
  if (code === 'provision_in_flight') return true;
  const status = (err as { status?: number } | null)?.status;
  if (status !== 409) return false;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('idempotency_key is in flight');
}

/**
 * Pick which existing project to open: the one the browser last had open, else
 * the first. `preferredProjectId` is untrusted (it comes from a cookie), so it
 * only ever selects from the list the server already said this account owns.
 */
export function pickLandingProject(
  projects: KortixProject[],
  preferredProjectId?: string | null,
): KortixProject | null {
  if (projects.length === 0) return null;
  if (isValidProjectId(preferredProjectId)) {
    const preferred = projects.find((project) => project.project_id === preferredProjectId);
    if (preferred) return preferred;
  }
  return projects[0] ?? null;
}

/**
 * The two network calls `ensureFirstProject` needs, injectable so tests can
 * pass plain fakes instead of module-mocking `@kortix/sdk` (which is
 * process-wide in this monorepo and leaks into sibling test suites — see
 * `mock.module` usage elsewhere in this package's tests for what NOT to
 * repeat). Defaults to the real SDK functions; production code never passes
 * this parameter.
 */
export type EnsureFirstProjectClient = {
  listProjectsForAccount: (accountId?: string) => Promise<KortixProject[]>;
  provisionProject: typeof provisionProject;
};

/**
 * Return the project this account should open, creating one when the account
 * has none.
 *
 * This deliberately provisions. The previous behaviour returned null for an
 * empty account and made the UI open the create-project modal, on the reasoning
 * that repository ownership is a user choice. That reasoning no longer holds:
 * sign-up already provisions a managed repo server-side, so the modal was a
 * manual step that only ever appeared when the automatic path had failed. The
 * BYO-repo choice stays available from the create flow.
 *
 * RETRY SAFETY. `/provision` is slow by design (it is on the long-request
 * deadline exemption list) and callers legitimately retry this ENTIRE
 * function on any error — a lost client-side response, a reload, the user
 * landing on the other entry point in a second tab. The list-then-create
 * shape above already makes a retry that arrives AFTER the server has
 * committed safe (the list finds the project). What it cannot cover is a
 * retry that arrives WHILE the first attempt is still creating — the list is
 * still empty, so a naive retry issues a second POST and a second managed git
 * repo. `getOrCreateProvisionAttemptKey` closes that gap: every retry of one
 * logical attempt sends the SAME `idempotency_key`, and the server-side
 * dedupe in `provision-idempotency.ts` collapses them to one project.
 */
export async function ensureFirstProject(
  accountId: string,
  opts: { preferredProjectId?: string | null; allowCreate?: boolean } = {},
  // A default parameter is re-evaluated on every call where `client` is
  // omitted — unlike a module-level constant, this keeps the real SDK calls
  // as ES module LIVE bindings (re-resolved per call) rather than a
  // snapshot taken once at module-evaluation time. That distinction is
  // load-bearing for this file's own tests, which re-register
  // `mock.module('@kortix/sdk', ...)` mid-suite.
  client: EnsureFirstProjectClient = { listProjectsForAccount, provisionProject },
): Promise<KortixProject | null> {
  const existing = await client.listProjectsForAccount(accountId);
  const picked = pickLandingProject(existing, opts.preferredProjectId);
  if (picked) {
    // The account already has what this attempt was trying to create. Drop
    // any leftover attempt token now, so a LATER, genuinely different attempt
    // (e.g. after the user deletes their only project) never replays a stale
    // key against an archived row — see the doc comment on
    // `getOrCreateProvisionAttemptKey`.
    clearProvisionAttemptKey(accountId);
    return picked;
  }
  if (opts.allowCreate === false) return null;

  const idempotencyKey = getOrCreateProvisionAttemptKey(accountId);

  try {
    const created = await client.provisionProject({
      account_id: accountId,
      name: FIRST_PROJECT_NAME,
      seed_starter: true,
      starter_template: FIRST_PROJECT_TEMPLATE,
      idempotency_key: idempotencyKey,
    });
    clearProvisionAttemptKey(accountId);
    return created;
  } catch (err) {
    // Three cases land here and all three mean "the account may already have
    // a project, go look before giving up":
    //  - `isProjectLimitError` — losing a create race against another tab.
    //  - `isProvisionInFlightError` — a concurrent call with this SAME key is
    //    still mid-provision (409, code `provision_in_flight`). This is a
    //    retryable state, not a failure: re-reading catches it the instant
    //    the other call's row becomes visible. If it isn't visible yet, this
    //    re-read finds nothing and the error below still propagates — the
    //    caller's own retry (with the SAME persisted key) is what waits out
    //    the rest.
    // A plain lost-response retry doesn't need special handling here at all:
    // it lands on the list-first check at the top of the NEXT call, not in
    // this catch.
    if (isProjectLimitError(err) || isProvisionInFlightError(err)) {
      const retry = await client.listProjectsForAccount(accountId);
      const retryPicked = pickLandingProject(retry, opts.preferredProjectId);
      if (retryPicked) {
        clearProvisionAttemptKey(accountId);
        return retryPicked;
      }
    }
    throw err;
  }
}

export function shouldAutoCreateFirstProject(state: FirstProjectAutoCreateState): boolean {
  if (!state.activeAccountId || !state.canCreateProjects) return false;
  if (state.autoCreateAttempted) return false;
  if (state.suppressedAfterDelete) return false;
  if (state.accountsLoading || state.projectsLoading || state.projectsError) return false;
  if (!state.projectsLoaded) return false;
  if (state.projectCount > 0) return false;
  if (state.legacyMachinesLoaded && state.legacyMachineCount > 0) return false;

  if (state.billingEnabled) {
    if (state.accountStateLoading) return false;
    if (!state.canRun) return false;
  }

  return true;
}
