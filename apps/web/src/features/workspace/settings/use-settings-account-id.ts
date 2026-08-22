'use client';

/**
 * Shared "which account is this tab configuring?" resolution for every
 * account-scoped settings tab (Connected accounts, and Phase 3's Billing,
 * Usage, Groups, Roles, Identity, Audit, API keys). Extracted from
 * `resolveConnectedAccountsId` (JAY-497, formerly a local export inside
 * `tabs/connected-tab.tsx`) before Phase 3's six new tabs each copied it.
 *
 * **Why the fallback exists — do not simplify this to `projectAccountId`
 * alone.** These tabs gate on `usePermission(accountId, '<action>')`, which
 * needs an account id to resolve at all. Sourcing it only from
 * `project?.account_id` means opening the panel with no project selected (or
 * before the project-detail query resolves) leaves the permission
 * unresolvable — not merely denied — so a gated control silently disappears
 * for a user who genuinely holds the permission. No error, no explanation.
 * This was a real bug found in review on `connected-tab.tsx` (see that
 * file's header comment, "Fix round 1", finding 1).
 *
 * `projectAccountId` (the open project's owning account, when a project is
 * open) wins when present — it is the most specific signal. Falls back to
 * `useCurrentAccountStore`'s `selectedAccountId` — the app-wide "currently
 * active account", set by the account switcher / project switcher and
 * persisted across sessions (`stores/current-account-store.ts`) — so
 * resolution still works with no project open.
 *
 * Two alternatives were considered and rejected (JAY-497); do not
 * re-litigate them: `useAuth()` exposes only a Supabase `user`/`session`,
 * with no account concept at all. `useBillingAccountId()` looked promising,
 * but its only provider (`project-shell.tsx`'s `BillingAccountProvider`) is
 * fed the identical `project?.account_id` — reading it here would just
 * re-derive the same project-scoped value, not an independent one.
 */

import { useCurrentAccountStore } from '@/stores/current-account-store';

/**
 * Pure resolver — exported so the fallback logic is unit-testable without a
 * mounted Zustand store. See this file's header comment for why the
 * fallback exists.
 */
export function resolveSettingsAccountId(
  projectAccountId: string | undefined,
  selectedAccountId: string | null | undefined,
): string | undefined {
  return projectAccountId ?? selectedAccountId ?? undefined;
}

/**
 * Reads the live `selectedAccountId` fallback and applies the resolver.
 * Every account-scoped settings tab should call this instead of reading
 * `project?.account_id` directly.
 */
export function useSettingsAccountId(projectAccountId?: string): string | undefined {
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  return resolveSettingsAccountId(projectAccountId, selectedAccountId);
}
