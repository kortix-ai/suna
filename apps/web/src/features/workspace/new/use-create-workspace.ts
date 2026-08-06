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
 */
export function messageFor(error: unknown): string {
  const status = (error as { status?: number } | null | undefined)?.status;
  const message = error instanceof Error ? error.message : undefined;
  if (status === 403) {
    return 'You need owner or admin access in this account to create a workspace.';
  }
  if (status === 400) return message || 'Check the workspace name and try again.';
  if (status === 502 || status === 503) return 'Could not create the workspace. Try again.';
  return message || 'Could not create the workspace. Try again.';
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
 * Drives the `/new` submit button: mints/reuses the idempotency key, POSTs
 * the create (with retry-on-in-flight via `runCreateAttempt`), primes the
 * workspace caches, and navigates to the new project on success.
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
} {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [lastState, setLastState] = useState<NewWorkspaceFormState | null>(null);

  const accountsQuery = useQuery({ queryKey: ['accounts'], queryFn: listAccounts, staleTime: 60_000 });
  const creatableAccounts = filterCreatableAccounts(accountsQuery.data ?? []);

  const create = useCallback(
    async (state: NewWorkspaceFormState) => {
      setLastState(state);
      setStatus('creating');
      setError(null);

      const fingerprint = fingerprintOf(state);
      const idempotencyKey = attemptKeyFor(fingerprint, Date.now());
      const payload = buildCreatePayload(
        state,
        creatableAccounts,
        idempotencyKey,
      ) as unknown as ProvisionProjectInput;

      try {
        const project = await runCreateAttempt(payload);
        // The attempt succeeded, so its key must never be replayed — a later
        // create with the same name would otherwise silently return THIS
        // workspace instead of creating a new one (see `r1.ts`'s
        // `idempotency_key` doc comment).
        clearAttemptKey(fingerprint);
        queryClient.setQueryData<KortixProject[]>(['projects', project.account_id], (existing) => [
          project,
          ...(existing ?? []),
        ]);
        void queryClient.invalidateQueries({ queryKey: ['projects'] });
        writeLastProjectId(user?.id, project.project_id);
        router.push(`/projects/${project.project_id}`);
      } catch (caught) {
        setStatus('error');
        setError(messageFor(caught));
      }
    },
    [creatableAccounts, queryClient, router, user?.id],
  );

  const retry = useCallback(() => {
    if (lastState) void create(lastState);
  }, [create, lastState]);

  return { create, status, error, phase: null as ProvisionPhase | null, retry };
}
