'use client';

import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

import { attemptKeyFor, clearAttemptKey } from '@/features/workspace/new/create-workspace-key';
import {
  buildProvisionPayload,
  filterCreatableAccounts,
  type NewWorkspaceFormState,
} from '@/features/workspace/new/new-workspace-form';
import { shouldRunOnboarding } from '@/features/workspace/new/onboarding-gate';
import { useAuth } from '@/features/providers/auth-provider';
import {
  isManagedGitUnavailableError,
  isProjectLimitError,
} from '@/lib/onboarding/ensure-first-project';
import { writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import {
  listAccounts,
  listProjectsForAccount,
  provisionProject,
  provisionProjectStream,
  setProjectOnboardingComplete,
  PROVISION_IN_FLIGHT_CODE,
  type KortixAccount,
  type KortixProject,
  type ProvisionPhase,
  type ProvisionProjectInput,
  type ProvisionStreamEvent,
} from '@kortix/sdk';

export type CreateStatus = 'idle' | 'creating' | 'error';

/**
 * Backoff for a 409 `provision_in_flight` retry, ms — one entry per retry.
 * Identical to `/projects/start`'s `RETRY_DELAY_MS`
 * (`app/(app)/projects/start/page.tsx:36`, `const RETRY_DELAY_MS = [400,
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
 * the first project (the exact failure mode `r1.ts`'s `idempotency_key` doc
 * comment warns about).
 */
export function fingerprintOf(state: NewWorkspaceFormState): string {
  return [state.accountId ?? 'default', state.name.trim(), state.templateId ?? '', state.source].join(
    ':',
  );
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
 * `creatableAccounts[0]?.account_id`, matched to the SAME filtered list the
 * picker itself renders from — never the raw, unfiltered account list.
 *
 * Extracted out of `buildCreatePayload` (below) so `runCreate`'s pre-create
 * existing-project-count read (`onboarding-gate.ts`) resolves the IDENTICAL
 * account the payload itself will use. Two independent resolutions here
 * could disagree — e.g. read account A's project count but actually create
 * in account B — silently mis-gating the onboarding wizard for a reason no
 * test on `buildCreatePayload` alone would ever catch.
 */
export function resolveTargetAccountId(
  state: NewWorkspaceFormState,
  creatableAccounts: KortixAccount[],
): string | undefined {
  return state.accountId ?? creatableAccounts[0]?.account_id;
}

/** The exact `POST /projects/provision` request body for one create attempt. */
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
 * transports (`provisionProject` and, since final-review FIX 1,
 * `provisionProjectStream`) throw an `ApiError` carrying the same fields, so
 * every branch below reads identically regardless of which one ran.
 *
 * 502 and 503 are NOT the same failure and must not share a message. This
 * route's only 503 is `isManagedGitUnavailableError`
 * (`ensure-first-project.ts:254`) — managed git is not configured on this
 * server, a server-config state no client-side retry can fix. Telling the
 * user to "try again" there is false: nothing they do changes the outcome
 * until an operator configures it. 502 (an upstream/gateway fault) keeps the
 * retryable generic message, matching every OTHER call site that reuses
 * `isManagedGitUnavailableError` (`project-create-modal.tsx:352`,
 * `add-to-project-modal.tsx:188`) — same title, so the wording never drifts
 * between the toast those use and the inline message here.
 *
 * `project_limit_reached` (final-review FIX 2) is checked BEFORE the generic
 * 403 branch, and deliberately, not folded into it: `enforceProjectQuota`
 * (`apps/api/src/projects/lib/access.ts`) returns 403 too, and
 * `FREE_TIER_PROJECT_LIMIT = 1` (`apps/api/src/shared/account-limits.ts`)
 * plus `ensureFirstProject` auto-provisioning every account's first project
 * means EVERY free-tier user who clicks "Create a workspace…" hits this —
 * not an edge case. The generic 403 message ("You need owner or admin
 * access…") is actively false for them: they have the role, they are simply
 * out of quota. The server's own message is reused verbatim rather than
 * inventing new copy — it already states the exact limit and the upgrade
 * path, matching what the deleted create modal's `isProjectLimitError`
 * handling reused for the same code (`ensure-first-project.ts`).
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
  if (isProjectLimitError(error)) {
    return message || "This account has reached its plan's workspace limit. Upgrade to create another.";
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
 *   `ensure-first-project.ts:254`) — NOT retryable. A server configuration
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
 * hazard for sibling test suites (see `ensure-first-project.ts`'s own
 * `EnsureFirstProjectClient` for the same pattern). `wait` is injected too, so
 * a test exercises the FULL retry budget without sleeping the real
 * 400ms/1200ms.
 */
export type CreateWorkspaceClient = {
  provisionProject: (input: ProvisionProjectInput) => Promise<KortixProject>;
  provisionProjectStream: (
    input: ProvisionProjectInput,
    onEvent: (event: ProvisionStreamEvent) => void,
  ) => Promise<KortixProject>;
  wait: (ms: number) => Promise<void>;
};

const defaultClient: CreateWorkspaceClient = {
  provisionProject,
  provisionProjectStream,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Whether a provisioning failure is TRANSPORT-shaped — the stream itself
 * never reached the server to do real work, as opposed to a real failure the
 * server reported through a stream that worked. `runProvisionAttempt` (below)
 * uses this, ALWAYS in combination with "zero events received", as the only
 * signal that its fallback to the plain `provisionProject` is safe: retrying
 * a genuine provisioning failure as a second `POST /projects/provision` risks
 * a second upstream managed repo, so this classifier stays conservative and
 * recognizes only the three shapes `provisionProjectStream`'s own doc comment
 * (`packages/sdk/src/core/rest/projects-client/projects.ts`) names as
 * "stream unavailable" failures:
 *
 * - **A raw network failure** — the `fetch()` call itself never got a
 *   response. Every fetch implementation (browsers, undici/Node, Bun) throws
 *   a `TypeError` for this, and ONLY for this; a server-returned failure
 *   (however bad) is always a plain `Error` or `ApiError`, never a
 *   `TypeError`. Checking the error's real TYPE, not a message string, is
 *   what keeps this from being the fragile message-sniffing the brief for
 *   this task explicitly warns against.
 * - **No `response.body`** — the React Native case. `provisionProjectStream`
 *   throws the literal message `'...(no response body)'`.
 * - **The `/projects/provision-stream` route itself 404s** — an older server
 *   build without it. `provisionProjectStream` throws
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
 * `apps/api/src/projects/routes/r1.ts` — retries up to `RETRY_DELAY_MS.length`
 * more times with the IDENTICAL payload. Never a re-minted key: the key
 * identifies the ATTEMPT, and the whole point of retrying is to land on that
 * same attempt's result. Any other error, or exhausting the retry budget,
 * rejects with the triggering error unchanged so the caller can classify it
 * (`messageFor`).
 */
export async function runCreateAttempt(
  payload: ProvisionProjectInput,
  client: CreateWorkspaceClient = defaultClient,
): Promise<KortixProject> {
  for (let attempt = 0; attempt <= RETRY_DELAY_MS.length; attempt += 1) {
    try {
      return await client.provisionProject(payload);
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
 * `provisionProjectStream` and falling back to the plain `runCreateAttempt`
 * (the 409-retrying `provisionProject` above) exactly once — and only when
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
 * `client.provisionProject` call) also means it inherits that function's own
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
 * (`apps/api/src/projects/provision-core.ts`), so by the time this failure
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
 * correct: either the server returns the SAME project once the in-flight
 * attempt commits, or it 409s again and the loop keeps waiting — never a
 * second upstream repo, and never a second create for this user intent.
 */
export async function runProvisionAttempt(
  payload: ProvisionProjectInput,
  onPhase: (phase: ProvisionPhase | null) => void,
  client: CreateWorkspaceClient = defaultClient,
): Promise<KortixProject> {
  let eventsReceived = 0;
  try {
    return await client.provisionProjectStream(payload, (event) => {
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
 * `attemptKeyFor`/`clearAttemptKey`/`writeLastProjectId`/`now` don't depend on
 * React and could be given real module-level defaults (as
 * `EnsureFirstProjectClient` does in `ensure-first-project.ts`); the other
 * three (`primeProjectCache`, `invalidateProjects`, `navigate`) are
 * inherently render-scoped — they close over the live `queryClient`/`router`
 * a hook only has inside a component — so there is no single "no-args"
 * default here. `useCreateWorkspace` below always supplies the whole object
 * explicitly; tests supply their own fakes for the render-scoped three and
 * the REAL functions (with a fake `localStorage`) for the rest.
 */
export type CreateOrchestrationClient = {
  attemptKeyFor: (fingerprint: string, now: number) => string;
  clearAttemptKey: (fingerprint: string) => void;
  runCreateAttempt: (payload: ProvisionProjectInput) => Promise<KortixProject>;
  primeProjectCache: (accountId: string, project: KortixProject) => void;
  invalidateProjects: () => void;
  writeLastProjectId: (userId: string | null | undefined, projectId: string) => void;
  navigate: (path: string) => void;
  now: () => number;
  /**
   * The target account's project count, read BEFORE this create (Task 20).
   * Feeds `shouldRunOnboarding` (`onboarding-gate.ts`) — see `runCreate`'s
   * own doc comment for why the read must happen before, not after.
   */
  getExistingProjectCount: (accountId: string) => Promise<number>;
  /**
   * `PATCH /projects/:projectId/onboarding` (the same endpoint
   * `useProjectOnboarding.complete()` already calls) with `completed: true`,
   * so the new project's own onboarding self-gate skips the wizard. May
   * reject — `runCreate` always swallows a rejection, never lets it fail the
   * create.
   */
  stampOnboardingComplete: (projectId: string) => Promise<void>;
};

export type CreateResult = { ok: true; project: KortixProject } | { ok: false; error: unknown };

/**
 * The full sequence one submit runs:
 *
 * ```
 * mint/reuse key -> read existing project count -> provision (with retry) ->
 *   [on success only] clear key -> prime cache -> invalidate -> write cookie
 *   -> stamp onboarding (if not the account's first project) -> navigate
 * ```
 *
 * The key is cleared FIRST among the success-path steps, before any of the
 * other four. The API's own contract (`r1.ts`) is that the key identifies the
 * ATTEMPT, not the payload — once the server has confirmed this attempt
 * succeeded, the key must never be replayed, or a LATER, genuinely different
 * create with the same name would silently return THIS project instead of
 * making a new one. Clearing it first, rather than last, also means that if
 * cache priming or navigation ever throws, the key is already gone and
 * cannot be resurrected by a subsequent retry.
 *
 * On any failure — including exhausting `runCreateAttempt`'s retry budget —
 * the key is deliberately left untouched, so a user-initiated retry (the
 * SAME `state`, submitted again) reuses it instead of minting a new one and
 * risking a second upstream repo.
 *
 * **Onboarding stamp (Task 20).** `client.getExistingProjectCount` is read
 * BEFORE `runCreateAttempt`, not after: `primeProjectCache` below prepends
 * the just-created project into the SAME `['projects', accountId]` cache
 * entry that read would otherwise come from, so a post-create read would
 * always see at least one project and `shouldRunOnboarding` would never see
 * 0 again — silently disabling the wizard for every account's genuine first
 * workspace. A failure reading the count is swallowed and falls back to `0`
 * (today's shipped default: the wizard runs) rather than throwing out of
 * `runCreate` — a count-read failure must not block the create any more than
 * a stamp failure may (see below).
 *
 * `shouldRunOnboarding` (`onboarding-gate.ts`) then decides, from that count,
 * whether this is the account's first project. If it is NOT, `runCreate`
 * fires `stampOnboardingComplete` — `PATCH /projects/:id/onboarding`, the
 * same endpoint `useProjectOnboarding.complete()` already calls — so the
 * new project's own self-gate (`metadata.onboarding_completed_at`) skips the
 * wizard on first paint instead of rendering it and having the user skip it
 * themselves.
 *
 * That call is fire-and-forget: NOT awaited, and placed before `navigate`
 * (same position as the already-fire-and-forget `invalidateProjects` above)
 * rather than after it. Awaiting it here would delay the user's arrival in a
 * workspace that already, successfully, exists — for a PATCH that has
 * nothing to do with whether the create succeeded. Firing it before
 * `navigate`, rather than after, only changes *when the request is kicked
 * off* relative to the SPA route change, not whether `runCreate` waits for
 * it; on this route change (`router.push`, no full page unload) an in-flight
 * `fetch` keeps running either way, so this ordering buys nothing in
 * reliability — it is chosen only to keep `navigate` as the visibly LAST
 * thing this function does, matching how every other success-path step reads
 * top-to-bottom. Its own rejection is caught and logged right here, never
 * left to reject unhandled and never rethrown: per the hard requirement, the
 * worst case of a failed stamp is one extra wizard render the user can skip,
 * and that must never be reported as a failed create.
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
  ) as unknown as ProvisionProjectInput;

  const targetAccountId = resolveTargetAccountId(state, creatableAccounts);
  const existingProjectCount = targetAccountId
    ? await client.getExistingProjectCount(targetAccountId).catch((countError: unknown) => {
        console.error('[useCreateWorkspace] Failed to read existing project count', {
          accountId: targetAccountId,
          error: countError,
        });
        return 0;
      })
    : 0;

  try {
    const project = await client.runCreateAttempt(payload);
    client.clearAttemptKey(fingerprint);
    client.primeProjectCache(project.account_id, project);
    client.invalidateProjects();
    client.writeLastProjectId(userId, project.project_id);
    if (!shouldRunOnboarding({ existingProjectCount })) {
      void client.stampOnboardingComplete(project.project_id).catch((stampError: unknown) => {
        console.error('[useCreateWorkspace] Failed to stamp onboarding complete', {
          projectId: project.project_id,
          error: stampError,
        });
      });
    }
    client.navigate(`/projects/${project.project_id}`);
    return { ok: true, project };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Drives the `/new` submit button: mints/reuses the idempotency key, POSTs
 * the create (with retry-on-in-flight via `runCreateAttempt`), primes the
 * workspace caches, and navigates to the new project on success. All of that
 * sequencing lives in `runCreate`, above — this hook only wires it to the
 * live `queryClient`/`router`/`user` and to component state.
 *
 * Fetches `['accounts']` itself — the same cache entry `new-workspace-page.tsx`,
 * `WorkspaceSwitcher` and `AccountSwitcher` already read — rather than taking
 * `creatableAccounts` as a parameter, so this hook can resolve the create's
 * target account (`resolveTargetAccountId`) without a second, page-specific
 * query. The onboarding-stamp gate (Task 20) reads a DIFFERENT cache entry —
 * `['projects', accountId]`, the exact key `WorkspaceSwitcher`,
 * `AccountSwitcher` and `project-create-modal.tsx` already use — via
 * `getExistingProjectCount` below; there is no `accounts.setup_complete_at`
 * involved anywhere in this gate.
 */
export function useCreateWorkspace(): {
  create: (state: NewWorkspaceFormState) => Promise<void>;
  status: CreateStatus;
  error: string | null;
  /**
   * The phase `POST /projects/provision-stream` last reported, or `null`
   * before the first event and while the plain-POST fallback is running (see
   * `runProvisionAttempt`'s `onPhase(null)`). Render it through
   * `phaseStatuses` (`provision-phases.ts`) for the full four-row checklist,
   * not this value alone.
   */
  phase: ProvisionPhase | null;
  retry: () => void;
  /** Whether `retry` can plausibly succeed for the CURRENT error; see `isRetryableError`. */
  canRetry: boolean;
} {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<ProvisionPhase | null>(null);
  // The raw thrown value, not just its formatted message — `canRetry` below
  // needs to classify it with `isRetryableError`, which reads `.status`, not
  // the already-rendered string.
  const [lastError, setLastError] = useState<unknown>(null);
  const [lastState, setLastState] = useState<NewWorkspaceFormState | null>(null);

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: listAccounts, staleTime: 60_000 });
  const creatableAccounts = filterCreatableAccounts(accountsQuery.data ?? []);

  const create = useCallback(
    async (state: NewWorkspaceFormState) => {
      setLastState(state);
      setStatus('creating');
      setError(null);
      setPhase(null);

      const result = await runCreate(state, creatableAccounts, user?.id, {
        attemptKeyFor,
        clearAttemptKey,
        runCreateAttempt: (payload) => runProvisionAttempt(payload, setPhase),
        primeProjectCache: (accountId, project) => {
          queryClient.setQueryData<KortixProject[]>(['projects', accountId], (existing) => [
            project,
            ...(existing ?? []),
          ]);
        },
        invalidateProjects: () => void queryClient.invalidateQueries({ queryKey: ['projects'] }),
        writeLastProjectId,
        navigate: (path) => router.push(path),
        now: Date.now,
        // Same `['projects', accountId]` cache key + `listProjectsForAccount`
        // queryFn `WorkspaceSwitcher`/`AccountSwitcher` already fetch
        // (`workspace-switcher.tsx:127-129`) — `ensureQueryData` reuses a warm
        // cache (the common case: reaching `/new` from either menu) and only
        // fetches when it's actually cold, rather than inventing a second
        // fetch shape for the same data.
        getExistingProjectCount: async (accountId) => {
          const projects = await queryClient.ensureQueryData({
            queryKey: ['projects', accountId],
            queryFn: () => listProjectsForAccount(accountId),
            staleTime: 30_000,
          });
          return projects.length;
        },
        stampOnboardingComplete: async (projectId) => {
          await setProjectOnboardingComplete(projectId, true);
        },
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

  return { create, status, error, phase, retry, canRetry };
}
