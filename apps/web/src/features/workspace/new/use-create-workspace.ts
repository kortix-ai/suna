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
import { useAuth } from '@/features/providers/auth-provider';
import { isManagedGitUnavailableError } from '@/lib/onboarding/ensure-first-project';
import { writeLastProjectId } from '@/lib/onboarding/last-project-cookie';
import {
  listAccounts,
  PROVISION_IN_FLIGHT_CODE,
  provisionProject,
  type KortixAccount,
  type KortixProject,
  type ProvisionProjectInput,
} from '@kortix/sdk';

export type CreateStatus = 'idle' | 'creating' | 'error';

/**
 * Provisioning stage streamed from the server while a create is in flight.
 *
 * Uninhabited on purpose. Task 19 switches this hook from `provisionProject`
 * to `provisionProjectStream` and defines the real stage union there — until
 * that lands, `phase` can only ever be `null`, which is exactly this task's
 * contract. Declaring the alias now (rather than typing the field bare `null`)
 * means Task 19 widens this alias — a non-breaking change — instead of adding
 * a field to `useCreateWorkspace`'s return shape, which would be a breaking
 * change for every consumer of this hook.
 */
export type ProvisionPhase = never;

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
 * The exact `POST /projects/provision` request body for one create attempt.
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
 */
export function buildCreatePayload(
  state: NewWorkspaceFormState,
  creatableAccounts: KortixAccount[],
  idempotencyKey: string,
): Record<string, unknown> {
  return {
    ...buildProvisionPayload(state),
    account_id: state.accountId ?? creatableAccounts[0]?.account_id,
    idempotency_key: idempotencyKey,
  };
}

/**
 * A user-facing message for a failed create.
 *
 * `ApiError` field names verified at
 * `packages/sdk/src/core/http/api/errors.ts:46-55`: `status?: number`,
 * `code?: string` — branches below read those, not invented names.
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
 */
export function messageFor(error: unknown): string {
  const status = (error as { status?: number } | null | undefined)?.status;
  const message = error instanceof Error ? error.message : undefined;
  if (status === 403) {
    return 'You need owner or admin access in this account to create a workspace.';
  }
  if (status === 400) return message || 'Check the workspace name and try again.';
  if (isManagedGitUnavailableError(error)) {
    return "Managed git isn't set up on this server. An admin needs to connect GitHub in Git settings before workspaces can be created.";
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

  return true;
}

/**
 * The one network call `runCreateAttempt` needs, injectable so its retry
 * logic is unit-tested with a plain fake instead of
 * `mock.module('@kortix/sdk', ...)` — process-wide in this monorepo and a
 * hazard for sibling test suites (see `ensure-first-project.ts`'s own
 * `EnsureFirstProjectClient` for the same pattern). `wait` is injected too, so
 * a test exercises the FULL retry budget without sleeping the real
 * 400ms/1200ms.
 */
export type CreateWorkspaceClient = {
  provisionProject: (input: ProvisionProjectInput) => Promise<KortixProject>;
  wait: (ms: number) => Promise<void>;
};

const defaultClient: CreateWorkspaceClient = {
  provisionProject,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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
};

export type CreateResult = { ok: true; project: KortixProject } | { ok: false; error: unknown };

/**
 * The full sequence one submit runs:
 *
 * ```
 * mint/reuse key -> provision (with retry) -> [on success only]
 *   clear key -> prime cache -> invalidate -> write cookie -> navigate
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

  try {
    const project = await client.runCreateAttempt(payload);
    client.clearAttemptKey(fingerprint);
    client.primeProjectCache(project.account_id, project);
    client.invalidateProjects();
    client.writeLastProjectId(userId, project.project_id);
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
 * `creatableAccounts` as a parameter, so Task 20's post-create destination
 * logic (which needs each account's `setup_complete_at`) has that data here
 * without a second, page-specific query.
 */
export function useCreateWorkspace(): {
  create: (state: NewWorkspaceFormState) => Promise<void>;
  status: CreateStatus;
  error: string | null;
  /** Null until Task 19 wires the stream; see {@link ProvisionPhase}. */
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

      const result = await runCreate(state, creatableAccounts, user?.id, {
        attemptKeyFor,
        clearAttemptKey,
        runCreateAttempt,
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

  return { create, status, error, phase: null as ProvisionPhase | null, retry, canRetry };
}
