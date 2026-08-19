'use client';

/**
 * One resolver for every legacy `/customize/<section>` and
 * `/settings/<tab>` deep link, including the account-scoped ones.
 *
 * **The problem this exists to solve.** `legacySectionRedirect(projectId,
 * rawSection)` is synchronous because every destination it knew was
 * project-scoped — a project id was the only input it needed. Organization
 * (General, Billing, Usage, Groups, Roles, Identity, Audit log) and API keys
 * left the overlay for `/accounts/[id]`, and that URL needs an ACCOUNT id.
 * An account id is not derivable from a project id in-process: it is
 * `project.account_id`, a field on the project detail, i.e. a network read.
 * So the map stayed synchronous (`ACCOUNT_GRADUATED` in `settings-tabs.ts`)
 * and the resolution moved here, to the call site, behind a hook.
 *
 * **Where the account id comes from, in priority order.**
 *   1. `project.account_id` from the project detail — authoritative. A
 *      multi-account user can deep-link into a project owned by an account
 *      that is NOT their currently-selected one; sending them to the selected
 *      account's billing page would be the wrong organization entirely.
 *   2. `useCurrentAccountStore`'s `selectedAccountId`, via
 *      `useSettingsAccountId` — the same fallback every account-scoped
 *      settings tab already used, and the same one
 *      `stores/account-settings-modal-store.ts` uses to build this exact URL.
 *      Covers the case where the detail read fails or the caller has no
 *      project.
 *
 * The detail query is `enabled` ONLY for an account-scoped section, so a
 * `/settings/secrets` link costs nothing extra. Under `ProjectShell` the
 * query key is already warm (`settings-panel.tsx` reads the same
 * `qk.project.detail`), so the common case resolves from cache with no
 * additional request.
 *
 * **`pending` is not cosmetic.** A redirect page that navigates the instant
 * it renders would fire before the account id is known and land on its bare
 * `/settings` fallback — silently dropping the destination the bookmark
 * named. Callers must hold while `pending` is true.
 */

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { isAccountGraduatedSection, legacySectionRedirect } from './settings-tabs';
import { useSettingsAccountId } from './use-settings-account-id';

export interface LegacySectionRedirect {
  /** Where to go, or `null` when the section resolves nowhere. */
  href: string | null;
  /** True while an account-scoped section is still waiting on its account id.
   *  Do not navigate — and do not fall back — until this is false. */
  pending: boolean;
}

/**
 * Resolve `rawSection` for `projectId`, paying for an account-id lookup only
 * when the section actually needs one.
 *
 * Hook rules apply: this must be called unconditionally, with the raw section
 * as an argument, not wrapped in a branch.
 */
export function useLegacySectionRedirect(
  projectId: string,
  rawSection: string | null | undefined,
): LegacySectionRedirect {
  const needsAccountId = isAccountGraduatedSection(rawSection);

  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: needsAccountId && !!projectId,
    ...contract('config'),
  });

  // Called unconditionally — it is a plain store read, and skipping it for a
  // project-scoped section would change the hook count between renders.
  const accountId = useSettingsAccountId(detail.data?.project?.account_id);

  if (!needsAccountId) {
    return { href: legacySectionRedirect(projectId, rawSection), pending: false };
  }

  // The detail read is the authoritative source. Keep waiting while it is in
  // flight AND the store fallback is empty; once either produces an id, or the
  // read settles without one, resolve. `isPending` (not `isLoading`) so a
  // disabled query — `projectId` empty — never wedges the caller.
  if (!accountId) {
    const stillReading = !!projectId && detail.isPending && !detail.isError;
    return { href: null, pending: stillReading };
  }

  return { href: legacySectionRedirect(projectId, rawSection, accountId), pending: false };
}
