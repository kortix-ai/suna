'use client';

import { useQuery } from '@tanstack/react-query';
import { getProjectQuota, type ProjectQuota } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';

/**
 * The project-cap state of the account a `/new` create would target, read
 * once on load so the page can show the cap reason BEFORE the user hits the
 * 403 a denied create answers (KRTX-2495).
 *
 * `accountId === null` is the single-creatable-account case: the query omits
 * `account_id` and the server resolves the SAME default account the create
 * itself targets (`resolveTargetAccountId` also omits it there — the two
 * must never disagree about which account they are asking about).
 *
 * `enabled: false` (accounts still loading) reads no data and no cap UI
 * renders — the page already keeps Create disabled while loading, so the
 * pre-check never answers for an account the create would not target.
 *
 * A failed pre-check is deliberately NOT an error surface: the page degrades
 * to the pre-fix behavior (no upfront cap state; the submit-time 403 still
 * teaches the cap) instead of blocking creation on a UI-only convenience.
 */
export function useProjectQuota(
  accountId: string | null | undefined,
  options: { enabled?: boolean } = {},
): { data: ProjectQuota | undefined } {
  const enabled = options.enabled ?? true;
  return useQuery({
    queryKey: qk.projects.quota(accountId ?? undefined),
    queryFn: () => getProjectQuota(accountId ? { accountId } : undefined),
    enabled,
  });
}
