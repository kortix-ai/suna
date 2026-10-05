/**
 * `/new?account=<accountId>` — which account the form creates the workspace in.
 *
 * Exists for one flow: the user just created an ACCOUNT. A brand-new account
 * owns no workspace, so the honest next step is this page — but the page's own
 * default (`resolveDefaultCreatableAccountId`) resolves to the user's PERSONAL
 * account, never the one they just made. Without this param, creating an
 * account and landing here would preselect the wrong account and quietly create
 * the first workspace somewhere else.
 *
 * The landing door (`/projects/start`) cannot serve this flow: it opens the
 * remembered project in ANY account (`decideDoor`), so an
 * empty new account always falls through to a different account's project —
 * and `start/page.tsx` then heals the persisted selection to THAT account,
 * undoing the switch the create just made.
 *
 * Validated only for shape here — emptiness and a uuid form. WHICH accounts are
 * legal is `filterCreatableAccounts`' answer, and the picker already renders an
 * id it cannot find as "Choose an account" rather than a broken row, so a stale
 * or hostile id degrades to the ordinary unpicked state instead of submitting
 * against an account the user may not create in. `POST /provision` is the
 * authoritative gate either way (403 "Owner or admin role required").
 */
import { isValidProjectId } from '@/lib/onboarding/landing-destination';

export function readAccountParam(params: URLSearchParams): string | null {
  const raw = params.get('account')?.trim();
  // Account ids and project ids are both plain uuids — one shape predicate,
  // deliberately reused rather than a second copy that can drift from it.
  return raw && isValidProjectId(raw) ? raw : null;
}

/** `/new` scoped to one account — the destination after creating an account. */
export function newWorkspacePathForAccount(accountId: string): string {
  return `/new?account=${encodeURIComponent(accountId)}`;
}
