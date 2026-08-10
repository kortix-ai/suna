'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { attemptKeyFor, clearAttemptKey } from '@/features/workspace/new/create-workspace-key';
import {
  buildProvisionPayload,
  filterCreatableAccounts,
  resolveDefaultCreatableAccountId,
  type NewWorkspaceFormState,
} from '@/features/workspace/new/new-workspace-form';
import { onboardingPath } from '@/features/workspace/new/onboarding-param';
import {
  isManagedGitUnavailableError,
  isWorkspaceLimitError,
} from '@/lib/onboarding/ensure-first-workspace';
import { writeLastWorkspaceId } from '@/lib/onboarding/last-workspace-cookie';
import {
  listAccounts,
  PROVISION_IN_FLIGHT_CODE,
  provisionWorkspace,
  provisionWorkspaceStream,
  type KortixAccount,
  type KortixWorkspace,
  type ProvisionPhase,
  type ProvisionStreamEvent,
  type ProvisionWorkspaceInput,
} from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

export type CreateStatus = 'idle' | 'creating' | 'error';

/**
 * Backoff for a 409 `provision_in_flight` retry, ms — one entry per retry.
 * Identical to `/workspaces/start`'s `RETRY_DELAY_MS`
 * (`app/(app)/workspaces/start/page.tsx:36`, `const RETRY_DELAY_MS = [400,
 * 1200]`): both doors run the SAME logical create against the same persisted
 * `idempotency_key`, so their backoffs must not diverge.
 */
export const RETRY_DELAY_MS = [400, 1_200];

/**
 * What makes one create *distinct* from another, for `attemptKeyFor`.
 *
 * Deliberately NOT the full form state. `icon` and `defaultBranch` are
 * refinements a user can still be adjusting between a failed submit and a
 * retry — a retry must reuse the SAME key, not mint a new one just because
 * the icon changed. `name`, `accountId`, `templateId` and `source` are what
 * actually identifies a genuinely different workspace: keying on those means
 * creating "suna-web" then, moments later, "kortix-api" in the same account
 * mints two independent keys instead of the second create silently returning
 * the first workspace (the exact failure mode `r1.ts`'s `idempotency_key` doc
 * comment warns about).
 */
export function fingerprintOf(state: NewWorkspaceFormState): string {
  return [
    state.accountId ?? 'default',
    state.name.trim(),
    state.templateId ?? '',
    state.source,
  ].join(':');
}

/**
 * The account a create actually targets.
 *
 * `account_id` is ALWAYS resolved here — never left for the server to
 * default from an omitted key. `resolveAccountId`
 * (`apps/api/src/shared/resolve-account.ts:117-129`) picks the caller's
 * EARLIEST-JOINED account membership with NO role check when `account_id` is
 * absent:
 *
 * ```ts
 * .where(eq(accountMembers.userId, userId))
 * .orderBy(accountMembers.joinedAt)
 * .limit(1)
 * ```
 *
 * A user who joined account A as a plain member in January and later created
 * account B as owner in March has exactly ONE creatable account (B) —
 * `AccountPicker` hides itself below two accounts
 * (`account-picker.tsx`), `state.accountId` stays legitimately `null`, and
 * `creatableAccounts.length === 1` no longer implies "the user has only one
 * account total". Omitting `account_id` in that case would resolve to A on
 * the server and 403 "Owner or admin role required" — precisely the failure
 * the picker's owner/admin filter (Task 12) exists to prevent, reopened
 * through the server's default path. So the fallback is
 * `resolveDefaultCreatableAccountId` (email match → primary owner → first
 * creatable) against the SAME filtered list the picker itself renders from —
 * never the raw, unfiltered account list.
 *
 * Extracted out of `buildCreatePayload` (below) as its own function so the
 * account a create actually targets is resolved in exactly one place.
 */
export function resolveTargetAccountId(
  state: NewWorkspaceFormState,
  creatableAccounts: KortixAccount[],
  email?: string | null,
): string | undefined {
  return state.accountId ?? resolveDefaultCreatableAccountId(creatableAccounts, email) ?? undefined;
}

/** The exact `POST /workspaces/provision` request body for one create attempt. */
export function buildCreatePayload(
  state: NewWorkspaceFormState,
  creatableAccounts: KortixAccount[],
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    ...buildProvisionPayload(state),
    account_id: resolveTargetAccountId(state, creatableAccounts),
    idempotency_key: idempotencyKey,
  };
}

/**
 * A user-facing message for a failed create.
 *
 * `ApiError` field names verified at
 * `packages/sdk/src/core/http/api/errors.ts:46-55`: `status?: number`,
 * `code?: string` — branches below read those, not invented names. Both
 * transports (`provisionWorkspace` and, since final-review FIX 1,
 * `provisionWorkspaceStream`) throw an `ApiError` carrying the same fields, so
 * every branch below reads identically regardless of which one ran.
 *
 * 502 and 503 are NOT the same failure and must not share a message. This
 * route's only 503 is `isManagedGitUnavailableError`
 * (`ensure-first-workspace.ts:254`) — managed git is not configured on this
 * server, a server-config state no client-side retry can fix. Telling the
 * user to "try again" there is false: nothing they do changes the outcome
 * until an operator configures it. 502 (an upstream/gateway fault) keeps the
 * retryable generic message, matching every OTHER call site that reuses
 * `isManagedGitUnavailableError` (`workspace-create-modal.tsx:352`,
 * `add-to-workspace-modal.tsx:188`) — same title, so the wording never drifts
 * between the toast those use and the inline message here.
 *
 * `project_limit_reached` (final-review FIX 2) is checked BEFORE the generic
 * 403 branch, and deliberately, not folded into it: `enforceProjectQuota`
 * (`apps/api/src/workspaces/lib/access.ts`) returns 403 too, and
 * `FREE_TIER_PROJECT_LIMIT = 1` (`apps/api/src/shared/account-limits.ts`)
 * plus `ensureFirstWorkspace` auto-provisioning every account's first workspace
 * means EVERY free-tier user who clicks "Create a workspace…" hits this —
 * not an edge case. The generic 403 message ("You need owner or admin
 * access…") is actively false for them: they have the role, they are simply
 * out of quota. The server's own message is reused verbatim rather than
 * inventing new copy — it already states the exact limit and the upgrade
 * path, matching what the deleted create modal's `isWorkspaceLimitError`
 * handling reused for the same code (`ensure-first-workspace.ts`).
 *
 * `provision_in_flight` (409, final-review FIX 1) also gets its own branch,
 * never the raw server text: `PROVISION_IN_FLIGHT_CODE`'s own doc comment
 * (`packages/sdk/src/core/http/api-client.ts`) names the literal string
 * "idempotency_key" as something that must never reach the user, and the
 * server's message for this case names it verbatim. By the time this branch
 * is reached, `runProvisionAttempt`'s own in-band retry (see its doc
 * comment) has already exhausted its backoff — this is the terminal case,
 * not the common one.
 */
export function messageFor(error: unknown): string {
  const status = (error as { status?: number } | null | undefined)?.status;
  const message = error instanceof Error ? error.message : undefined;
  if (isWorkspaceLimitError(error)) {
    return "This account has reached its plan's workspace limit. Upgrade to create another.";
  }
  if (status === 403) {
    return 'You need owner or admin access in this account to create a workspace.';
  }
  if (status === 400) return message || 'Check the workspace name and try again.';
  if (isManagedGitUnavailableError(error)) {
    return "Managed git isn't set up on this server. An admin needs to connect GitHub in Git settings before workspaces can be created.";
  }
  if (status === 409) {
    return 'Another attempt to create this workspace is already in progress. Please wait a moment and try again.';
  }
  if (status === 502) return 'Could not create the workspace. Try again.';
  return message || 'Could not create the workspace. Try again.';
}

/**
 * Whether a failed create should offer a retry.
 *
 * Classified by whether ANYTHING could plausibly be different on the next
 * attempt — NOT by "everything except 503". `retry` (below) resends
 * `lastState` completely unedited, through the SAME `runCreate` path with
 * the SAME persisted `idempotency_key`, so a failure whose cause cannot
 * change between now and a later click must not offer one; doing so would
 * spend the user's next click on a request guaranteed to fail identically.
 * Fix round 1 finding: the first version of this function offered a retry
 * for a 400 too, which fails this exact test — see the `status === 400`
 * branch below.
 *
 * - `400` (bad name / invalid payload) — NOT retryable. `retry` resends the
 *   exact payload that just failed validation; a deterministic validation
 *   failure on an unchanged payload fails identically every time. Only
 *   editing the name, through the primary submit button, can help.
 * - `403` (wrong account / insufficient role) — retryable. Role and account
 *   membership are external state that CAN genuinely change between the
 *   failure and a later click, and `retry` re-closes over `creatableAccounts`
 *   (`useCreateWorkspace`'s own `['accounts']` query), which is refetched —
 *   so a role grant made in the meantime can turn this into a success.
 * - `502` (bad gateway) — retryable. A transient upstream/gateway fault; a
 *   later attempt can land differently with no change on the client at all.
 * - `503` (this route's only 503 is `isManagedGitUnavailableError`,
 *   `ensure-first-workspace.ts:254`) — NOT retryable. A server configuration
 *   state; see `messageFor` above. Reuses that detector rather than
 *   re-deriving the 503 check, so this and `messageFor` can never disagree
 *   about which failure is which.
 * - `409` (`provision_in_flight`, final-review FIX 1) — retryable. Named
 *   explicitly rather than left to the default bucket: whether ANOTHER
 *   attempt with this key is still running is external state by
 *   definition, and it usually resolves within `runProvisionAttempt`'s own
 *   in-band backoff before ever reaching here (see that function's doc
 *   comment) — this branch only fires once that backoff is exhausted, and
 *   the underlying condition can still clear before the user's next click.
 * - Anything else (a plain network `Error`, an unrecognized status) —
 *   retryable. There is no signal here that rules out transience, so the
 *   safer default is to offer the retry rather than silently block a case
 *   that might actually succeed.
 *
 * Adding a new status code this route can return? Decide which bucket above
 * it belongs to — "the payload/state is deterministic and unchanged" (block
 * it) vs. "something could genuinely be different next time" (allow it) —
 * and add its own named branch rather than folding it into the default.
 */
export function isRetryableError(error: unknown): boolean {
  const status = (error as { status?: number } | null | undefined)?.status;

  if (status === 400) return false;
  if (isManagedGitUnavailableError(error)) return false;
  if (status === 409) return true;

  return true;
}

/**
 * The network calls `runCreateAttempt` and `runProvisionAttempt` need,
 * injectable so their logic is unit-tested with a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — process-wide in this monorepo and a
 * hazard for sibling test suites (see `ensure-first-workspace.ts`'s own
 * `EnsureFirstWorkspaceClient` for the same pattern). `wait` is injected too, so
 * a test exercises the FULL retry budget without sleeping the real
 * 400ms/1200ms.
 */
export type CreateWorkspaceClient = {
  provisionWorkspace: (input: ProvisionWorkspaceInput) => Promise<KortixWorkspace>;
  provisionWorkspaceStream: (
    input: ProvisionWorkspaceInput,
    onEvent: (event: ProvisionStreamEvent) => void,
  ) => Promise<KortixWorkspace>;
  wait: (ms: number) => Promise<void>;
};

const defaultClient: CreateWorkspaceClient = {
  provisionWorkspace,
  provisionWorkspaceStream,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Whether a provisioning failure is TRANSPORT-shaped — the stream itself
 * never reached the server to do real work, as opposed to a real failure the
 * server reported through a stream that worked. `runProvisionAttempt` (below)
 * uses this, ALWAYS in combination with "zero events received", as the only
 * signal that its fallback to the plain `provisionWorkspace` is safe: retrying
 * a genuine provisioning failure as a second `POST /workspaces/provision` risks
 * a second upstream managed repo, so this classifier stays conservative and
 * recognizes only the three shapes `provisionWorkspaceStream`'s own doc comment
 * (`packages/sdk/src/core/rest/workspaces-client/workspaces.ts`) names as
 * "stream unavailable" failures:
 *
 * - **A raw network failure** — the `fetch()` call itself never got a
 *   response. Every fetch implementation (browsers, undici/Node, Bun) throws
 *   a `TypeError` for this, and ONLY for this; a server-returned failure
 *   (however bad) is always a plain `Error` or `ApiError`, never a
 *   `TypeError`. Checking the error's real TYPE, not a message string, is
 *   what keeps this from being the fragile message-sniffing the brief for
 *   this task explicitly warns against.
 * - **No `response.body`** — the React Native case. `provisionWorkspaceStream`
 *   throws the literal message `'...(no response body)'`.
 * - **The `/workspaces/provision-stream` route itself 404s** — an older server
 *   build without it. `provisionWorkspaceStream` throws
 *   `` `Provision failed: HTTP ${status}` `` when the response is non-2xx and
 *   carries no JSON `error` field; a REAL API rejection (400/403/503) always
 *   carries one, and lands in the pre-stream-denial branch below instead.
 *
 * Everything else — an in-stream `error` event, a pre-stream non-2xx WITH a
 * server message (e.g. "Owner or admin role required"), a malformed-frame
 * parse failure — is a REAL failure and must rethrow, never fall back.
 */
export function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  return error.message.includes('no response body') || /\bHTTP 404\b/.test(error.message);
}

/**
 * Runs one logical create to completion.
 *
 * POSTs once. On a `409` `provision_in_flight` — another call carrying this
 * SAME `idempotency_key` is still mid-provision, per
 * `apps/api/src/workspaces/routes/r1.ts` — retries up to `RETRY_DELAY_MS.length`
 * more times with the IDENTICAL payload. Never a re-minted key: the key
 * identifies the ATTEMPT, and the whole point of retrying is to land on that
 * same attempt's result. Any other error, or exhausting the retry budget,
 * rejects with the triggering error unchanged so the caller can classify it
 * (`messageFor`).
 */
export async function runCreateAttempt(
  payload: ProvisionWorkspaceInput,
  client: CreateWorkspaceClient = defaultClient,
): Promise<KortixWorkspace> {
  for (let attempt = 0; attempt <= RETRY_DELAY_MS.length; attempt += 1) {
    try {
      return await client.provisionWorkspace(payload);
    } catch (caught) {
      const code = (caught as { code?: string } | null | undefined)?.code;
      const canRetry = code === PROVISION_IN_FLIGHT_CODE && attempt < RETRY_DELAY_MS.length;
      if (!canRetry) throw caught;
      await client.wait(RETRY_DELAY_MS[attempt]!);
    }
  }
  // Unreachable: every iteration above either returns or throws.
  throw new Error('runCreateAttempt: retry loop exited without resolving');
}

/**
 * One provisioning attempt, preferring the live-progress
 * `provisionWorkspaceStream` and falling back to the plain `runCreateAttempt`
 * (the 409-retrying `provisionWorkspace` above) exactly once — and only when
 * the fallback is provably safe.
 *
 * The gate is **whether `onEvent` fired at all**, not the shape of the error
 * that follows. If the stream delivered even ONE event — a phase, or even
 * the terminal `error` event itself — it reached the server and did real
 * work, so ANY failure after that is a genuine provisioning failure and MUST
 * rethrow. Retrying it as a fresh `runCreateAttempt` call would be a SECOND
 * create for the same user intent — the exact "two upstream repos" failure
 * this function exists to prevent. Only when NOTHING was ever received AND
 * the failure is transport-shaped (`isTransportFailure`) is it safe to
 * conclude the stream never reached the server, and the fallback runs.
 *
 * The fallback reuses `payload` UNCHANGED — same `idempotency_key` the
 * streaming attempt just sent. It is the SAME logical attempt continuing on
 * a different transport, not a new one; a re-minted key here would be
 * exactly the bug this function exists to prevent, just moved one layer up.
 * Routing the fallback through `runCreateAttempt` (rather than a bare
 * `client.provisionWorkspace` call) also means it inherits that function's own
 * 409 `provision_in_flight` retry, so the plain-POST path keeps its full
 * existing resilience even when reached through the stream.
 *
 * `onPhase(null)` fires once, right before the fallback runs — there is no
 * real phase information once the plain POST takes over, and freezing the UI
 * on the last streamed phase would show progress that stopped being true.
 *
 * **DECISION (final-review FIX 1, consequence 3): a 409 `provision_in_flight`
 * error ALSO reaches the fallback, regardless of `eventsReceived`.**
 * `emit('validating')` is the first statement of `runProvision`
 * (`apps/api/src/workspaces/provision-core.ts`), so by the time this failure
 * can arrive at all, `eventsReceived > 0` is already guaranteed — under the
 * plain "any event blocks fallback" rule, that made `runCreateAttempt`'s own
 * 409 backoff loop unreachable from the streaming path, the exact "409
 * backoff is dead on the primary path" finding from the final review. This
 * is deliberately narrower than the transport-failure gate above it, not a
 * loosening of it: a `provision_in_flight` failure is not "a genuine
 * provisioning failure that must never be retried as a second create" the
 * way a 502/503/plain error is. By construction it means another call
 * carrying this SAME `idempotency_key` is already mid-provision, so handing
 * it to `runCreateAttempt` (identical key, unchanged payload) is exactly
 * correct: either the server returns the SAME workspace once the in-flight
 * attempt commits, or it 409s again and the loop keeps waiting — never a
 * second upstream repo, and never a second create for this user intent.
 */
export async function runProvisionAttempt(
  payload: ProvisionWorkspaceInput,
  onPhase: (phase: ProvisionPhase | null) => void,
  client: CreateWorkspaceClient = defaultClient,
): Promise<KortixWorkspace> {
  let eventsReceived = 0;
  try {
    return await client.provisionWorkspaceStream(payload, (event) => {
      eventsReceived += 1;
      if (event.type === 'phase') onPhase(event.phase);
    });
  } catch (streamFailure) {
    const code = (streamFailure as { code?: string } | null | undefined)?.code;
    const isProvisionInFlight = code === PROVISION_IN_FLIGHT_CODE;
    if (!isProvisionInFlight && (eventsReceived > 0 || !isTransportFailure(streamFailure))) {
      throw streamFailure;
    }
    onPhase(null);
    return runCreateAttempt(payload, client);
  }
}

/**
 * Every side effect `runCreate` drives, injected so the FULL orchestration
 * (not just the provision sub-step `runCreateAttempt` already covers) is
 * unit-tested — same reason as `CreateWorkspaceClient` above: no
 * `mock.module('@kortix/sdk', ...)`, which is process-wide in this monorepo.
 *
 * `attemptKeyFor`/`clearAttemptKey`/`writeLastWorkspaceId`/`now` don't depend on
 * React and could be given real module-level defaults (as
 * `EnsureFirstWorkspaceClient` does in `ensure-first-workspace.ts`); the other
 * three (`primeWorkspaceCache`, `invalidateWorkspaces`, `enterOnboarding`) are
 * inherently render-scoped — they close over the live `queryClient`/`router`
 * a hook only has inside a component — so there is no single "no-args"
 * default here. `useCreateWorkspace` below always supplies the whole object
 * explicitly; tests supply their own fakes for the render-scoped three and
 * the REAL functions (with a fake `localStorage`) for the rest.
 */
export type CreateOrchestrationClient = {
  attemptKeyFor: (fingerprint: string, now: number) => string;
  clearAttemptKey: (fingerprint: string) => void;
  runCreateAttempt: (payload: ProvisionWorkspaceInput) => Promise<KortixWorkspace>;
  primeWorkspaceCache: (accountId: string, workspace: KortixWorkspace) => void;
  invalidateWorkspaces: () => void;
  writeLastWorkspaceId: (userId: string | null | undefined, workspaceId: string) => void;
  /**
   * Hand off to the guided onboarding, which runs on `/new` itself rather
   * than on the new workspace's page.
   *
   * This replaced a `navigate('/workspaces/:id')`. Onboarding cannot run there:
   * the wizard is mounted on the workspace shell but self-gates on
   * `metadata.onboarding_completed_at`, and this function used to stamp that
   * field before navigating — so the wizard rendered `null` every time. The
   * stamp now comes from the wizard's own `complete()` instead, which means
   * the workspace shell's copy correctly renders nothing once the user arrives.
   *
   * Implemented as `router.replace`, never `push`: the form state this
   * replaces is not somewhere the user may navigate back into.
   */
  enterOnboarding: (workspaceId: string) => void;
  now: () => number;
};

export type CreateResult = { ok: true; workspace: KortixWorkspace } | { ok: false; error: unknown };

/**
 * The full sequence one submit runs:
 *
 * ```
 * mint/reuse key -> provision (with retry) ->
 *   [on success only] clear key -> prime cache -> invalidate -> write cookie
 *   -> enter onboarding on /new
 * ```
 *
 * **No onboarding gate.** An earlier version read the account's workspace count
 * here and pre-stamped the new workspace onboarded unless it was the account's
 * first. That gate could never fire: the account's first workspace is
 * auto-provisioned (`ensure-first-workspace.ts`), never created through `/new`,
 * so the count was always >= 1 by the time anyone reached this code — and the
 * pre-stamp made the wizard render `null` on arrival, every single time.
 * Every `/new` create now runs onboarding, and the only thing that stamps the
 * workspace is the wizard finishing.
 *
 * The key is cleared FIRST among the success-path steps, before any of the
 * other four. The API's own contract (`r1.ts`) is that the key identifies the
 * ATTEMPT, not the payload — once the server has confirmed this attempt
 * succeeded, the key must never be replayed, or a LATER, genuinely different
 * create with the same name would silently return THIS workspace instead of
 * making a new one. Clearing it first, rather than last, also means that if
 * cache priming or entering onboarding ever throws, the key is already gone
 * and cannot be resurrected by a subsequent retry.
 *
 * On any failure — including exhausting `runCreateAttempt`'s retry budget —
 * the key is deliberately left untouched, so a user-initiated retry (the
 * SAME `state`, submitted again) reuses it instead of minting a new one and
 * risking a second upstream repo.
 */
export async function runCreate(
  state: NewWorkspaceFormState,
  creatableAccounts: KortixAccount[],
  userId: string | null | undefined,
  client: CreateOrchestrationClient,
): Promise<CreateResult> {
  const fingerprint = fingerprintOf(state);
  const idempotencyKey = client.attemptKeyFor(fingerprint, client.now());
  const payload = buildCreatePayload(
    state,
    creatableAccounts,
    idempotencyKey,
  ) as unknown as ProvisionWorkspaceInput;

  try {
    const workspace = await client.runCreateAttempt(payload);
    client.clearAttemptKey(fingerprint);
    client.primeWorkspaceCache(workspace.account_id, workspace);
    client.invalidateWorkspaces();
    client.writeLastWorkspaceId(userId, workspace.workspace_id);
    client.enterOnboarding(workspace.workspace_id);
    return { ok: true, workspace };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Drives the `/new` submit button: mints/reuses the idempotency key, POSTs
 * the create (with retry-on-in-flight via `runCreateAttempt`), primes the
 * workspace caches, and enters the guided onboarding for the new workspace on
 * success. All of that sequencing lives in `runCreate`, above — this hook
 * only wires it to the live `queryClient`/`router`/`user` and to component
 * state.
 *
 * Fetches `['accounts']` itself — the same cache entry `new-workspace-page.tsx`,
 * `WorkspaceSwitcher` and `AccountSwitcher` already read — rather than taking
 * `creatableAccounts` as a parameter, so this hook can resolve the create's
 * target account (`resolveTargetAccountId`) without a second, page-specific
 * query.
 */
export function useCreateWorkspace(): {
  create: (state: NewWorkspaceFormState) => Promise<void>;
  status: CreateStatus;
  error: string | null;
  retry: () => void;
  /** Whether `retry` can plausibly succeed for the CURRENT error; see `isRetryableError`. */
  canRetry: boolean;
} {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  // The raw thrown value, not just its formatted message — `canRetry` below
  // needs to classify it with `isRetryableError`, which reads `.status`, not
  // the already-rendered string.
  const [lastError, setLastError] = useState<unknown>(null);
  const [lastState, setLastState] = useState<NewWorkspaceFormState | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: listAccounts,
    staleTime: 60_000,
  });
  const creatableAccounts = filterCreatableAccounts(accountsQuery.data ?? []);

  const create = useCallback(
    async (state: NewWorkspaceFormState) => {
      setLastState(state);
      setStatus('creating');
      setError(null);

      const result = await runCreate(state, creatableAccounts, user?.id, {
        attemptKeyFor,
        clearAttemptKey,
        // `onPhase` is a no-op: `/new` shows `WorkspaceHandoff`, one mark held
        // across the whole wait, and reports no per-phase progress. The
        // parameter stays on `runProvisionAttempt` because that function's own
        // fallback depends on it — `onPhase(null)` is how it marks the switch
        // to the plain POST — and because it is what a host WOULD read to
        // render progress. Nothing here consumes it, so nothing here holds
        // state for it.
        runCreateAttempt: (payload) => runProvisionAttempt(payload, () => {}),
        // The optimistic write goes ONLY into the account this workspace
        // actually belongs to — the one entry a merge here can never get
        // wrong. `qk.workspaces.list()` (no account) is a DIFFERENT, sibling
        // cache entry backing callers that let the API resolve the account,
        // so hand-merging into it could inject this workspace into the wrong
        // account's cached list. The invalidate below reaches that slot too,
        // correctly, via a real fetch instead of a guess.
        primeWorkspaceCache: (accountId, workspace) => {
          queryClient.setQueryData<KortixWorkspace[]>(qk.workspaces.list(accountId), (existing) => [
            workspace,
            ...(existing ?? []),
          ]);
        },
        // `qk.workspaces.scope()`, NOT `qk.workspaces.list()`. Under the old flat
        // keys `['workspaces']` was a genuine PREFIX of `['workspaces', accountId]`,
        // so invalidating it reached every account's list. Under `qk` those two
        // are SIBLINGS (`'all'` vs `'<id>'`), so `list()` alone would match only
        // the accountless slot and silently stop refreshing the list this
        // create just added to. `scope()` is the shared prefix over every form.
        invalidateWorkspaces: () =>
          void queryClient.invalidateQueries({ queryKey: qk.workspaces.scope() }),
        writeLastWorkspaceId,
        enterOnboarding: (workspaceId) => router.replace(onboardingPath(workspaceId)),
        now: Date.now,
      });

      if (!result.ok) {
        setStatus('error');
        setError(messageFor(result.error));
        setLastError(result.error);
      }
    },
    [creatableAccounts, queryClient, router, user?.id],
  );

  const retry = useCallback(() => {
    if (lastState) void create(lastState);
  }, [create, lastState]);

  // Gated on `status === 'error'` as well as `isRetryableError`, not just the
  // latter: `lastError` deliberately outlives one failed attempt (it is
  // never cleared on success or on the next `create()` call other than by a
  // fresh failure overwriting it), so without the status check `canRetry`
  // could still read `true`/`false` from a PREVIOUS failure while a new
  // create is `'creating'` or has already succeeded.
  const canRetry = status === 'error' && isRetryableError(lastError);

  return { create, status, error, retry, canRetry };
}
