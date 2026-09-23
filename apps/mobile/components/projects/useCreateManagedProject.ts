/**
 * Create a managed project — the one create path for `NewProjectSheet` and
 * the full-screen `/new` (COR-161). Validates the name
 * (`lib/projects/new-project-form.ts`), provisions with the starter skill kit,
 * and reports the result with haptics and a toast. Resolves to the project,
 * or null when validation or the request failed (already reported).
 *
 * Every create carries an `idempotency_key` (COR-186,
 * `lib/projects/provision-attempt.ts`): one key per account + name, reused by
 * every retry of that create, cleared on success. A lost response (no HTTP
 * status — a `java.net` error on Android) is retried once with the same key,
 * so the server hands back the project it already made instead of a second
 * one or, on the free plan, `project_limit_reached`. A `409
 * provision_in_flight` waits and retries with the same key, as web does.
 * A limit error goes to `onLimitReached` when the caller passes one (`/new`
 * opens the account's project instead of dead-ending).
 */

import { useCallback, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';

import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { useProvisionProject } from '@/lib/projects/hooks';
import { validateProjectName } from '@/lib/projects/new-project-form';
import type { KortixProject } from '@/lib/projects/projects-client';
import {
  attemptFingerprint,
  createAttemptKeys,
  isLostResponseError,
  isProjectLimitError,
  isProvisionInFlightError,
  LOST_RESPONSE_RETRY_MS,
  PROVISION_IN_FLIGHT_RETRY_MS,
} from '@/lib/projects/provision-attempt';
import { starterTemplateForManagedProject } from './project-starter-template';

/** App-wide: a retry from `/new` and from the sheet share one key per create. */
const attemptKeys = createAttemptKeys(() => Crypto.randomUUID());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface CreateManagedProjectOptions {
  /**
   * The account is at its project limit. Resolve `true` when the caller
   * handled it (no error toast), `false` to show the server's message.
   */
  onLimitReached?: (accountId: string) => Promise<boolean>;
}

export function useCreateManagedProject() {
  const provision = useProvisionProject();
  const toast = useToast();
  const { mutateAsync } = provision;
  // True across the whole attempt, retries and backoff included:
  // `provision.isPending` drops between retries, which would let a second tap in.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  /** One create: the same key through every retry; resolves or reports. */
  const attempt = useCallback(
    async (accountId: string, projectName: string, options: CreateManagedProjectOptions) => {
      const fingerprint = attemptFingerprint(accountId, projectName);
      const idempotencyKey = attemptKeys.keyFor(fingerprint, Date.now());
      let lostRetried = false;
      let inFlightRetries = 0;
      for (;;) {
        try {
          const project = await mutateAsync({
            account_id: accountId,
            name: projectName,
            starter_template: starterTemplateForManagedProject(),
            idempotency_key: idempotencyKey,
          });
          attemptKeys.clear(fingerprint);
          haptics.success();
          toast.success('Project created');
          return project;
        } catch (err: any) {
          if (isProvisionInFlightError(err) && inFlightRetries < PROVISION_IN_FLIGHT_RETRY_MS.length) {
            await sleep(PROVISION_IN_FLIGHT_RETRY_MS[inFlightRetries++]);
            continue;
          }
          if (isLostResponseError(err) && !lostRetried) {
            lostRetried = true;
            await sleep(LOST_RESPONSE_RETRY_MS);
            continue;
          }
          haptics.warning();
          if (isProjectLimitError(err) && options.onLimitReached) {
            const handled = await options.onLimitReached(accountId).catch(() => false);
            if (handled) return null;
          }
          toast.error(
            isLostResponseError(err)
              ? "Couldn't reach Kortix. Check your connection and try again."
              : err?.message || 'Failed to create project'
          );
          return null;
        }
      }
    },
    [mutateAsync, toast]
  );

  const create = useCallback(
    async (
      accountId: string | null,
      rawName: string,
      options: CreateManagedProjectOptions = {}
    ): Promise<KortixProject | null> => {
      if (!accountId) {
        toast.error('Select an account first');
        return null;
      }
      const name = validateProjectName(rawName);
      if (!name.ok) {
        toast.error(name.error);
        return null;
      }
      if (creatingRef.current) return null;
      creatingRef.current = true;
      setCreating(true);
      haptics.medium();
      try {
        return await attempt(accountId, name.name, options);
      } finally {
        creatingRef.current = false;
        setCreating(false);
      }
    },
    [attempt, toast]
  );

  return { create, isPending: creating || provision.isPending };
}
