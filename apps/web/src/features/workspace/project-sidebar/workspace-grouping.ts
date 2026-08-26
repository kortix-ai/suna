import type { KortixAccount, KortixProject } from '@kortix/sdk';

/**
 * The switcher menu is the only complete workspace directory in the product —
 * the `/projects` index that used to hold that job is gone. So this grouping is
 * the whole navigation model, not a convenience view, and it must never drop a
 * workspace the user can reach.
 *
 * That is why an orphan workspace (one whose account is missing from
 * `accounts`, e.g. a shared project in an account the user is not a member of)
 * still gets a group rather than being filtered out.
 */

/** Shown when an account has no usable name. Never blank. */
const FALLBACK_ACCOUNT_NAME = 'Account';

/**
 * The account name as a HUMAN reads it in a switcher.
 *
 * A personal account is created as "<Name>'s Account", so an unprocessed list
 * of them reads "Jay's Account / Ada's Account / Acme" — the same four words
 * repeated down the column, with the one distinguishing token buried at the
 * front. The suffix carries no information in a control whose every row is
 * already an account, so it comes off.
 *
 * Both apostrophes, because the two are indistinguishable on screen and a
 * name typed with a curly one would otherwise keep its suffix while its
 * neighbour lost it. Falls back rather than returning empty: an account
 * literally named "'s Account" would strip to nothing, and a blank heading is
 * worse than a redundant one.
 */
export function workspaceAccountLabel(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return FALLBACK_ACCOUNT_NAME;
  const stripped = trimmed.replace(/[\u2019']s Account$/u, '').trim();
  return stripped || trimmed;
}

export interface WorkspaceGroup {
  accountId: string;
  accountName: string;
  workspaces: KortixProject[];
}

export interface GroupWorkspacesInput {
  accounts: Pick<KortixAccount, 'account_id' | 'name'>[];
  workspaces: KortixProject[];
  /** The workspace currently open, if any. Its account sorts first. */
  activeWorkspaceId: string | null | undefined;
}

function openedAt(workspace: KortixProject): number {
  return workspace.last_opened_at ? new Date(workspace.last_opened_at).getTime() : 0;
}

export function groupWorkspacesByAccount({
  accounts,
  workspaces,
  activeWorkspaceId,
}: GroupWorkspacesInput): WorkspaceGroup[] {
  const nameByAccountId = new Map(
    accounts.map((account) => [account.account_id, account.name?.trim() || FALLBACK_ACCOUNT_NAME]),
  );

  const byAccountId = new Map<string, KortixProject[]>();
  for (const workspace of workspaces) {
    const bucket = byAccountId.get(workspace.account_id);
    if (bucket) bucket.push(workspace);
    else byAccountId.set(workspace.account_id, [workspace]);
  }

  const activeAccountId =
    workspaces.find((workspace) => workspace.project_id === activeWorkspaceId)?.account_id ?? null;

  const groups: WorkspaceGroup[] = [...byAccountId.entries()].map(([accountId, list]) => ({
    accountId,
    accountName: nameByAccountId.get(accountId) ?? FALLBACK_ACCOUNT_NAME,
    workspaces: [...list].sort((a, b) => openedAt(b) - openedAt(a)),
  }));

  groups.sort((a, b) => {
    if (a.accountId === activeAccountId) return -1;
    if (b.accountId === activeAccountId) return 1;
    return a.accountName.localeCompare(b.accountName);
  });

  return groups;
}

/**
 * The account the switcher is currently scoped to — what "Account settings"
 * in this menu opens.
 *
 * Resolution order, most specific first:
 *
 * 1. the account owning the workspace you have open. A user in two accounts
 *    reads the menu as "settings for where I am", and the open workspace is
 *    the only unambiguous statement of that;
 * 2. `selectedAccountId`, for a mount with no workspace in the URL. It is
 *    persisted (`stores/current-account-store`) so it is present on the first
 *    paint of a returning visit, before any query resolves;
 * 3. the first account, matching the seed `useEnsureSelectedAccount` writes.
 *
 * `null` only while the user's accounts are genuinely unknown. Callers MUST
 * treat that as "render no link" rather than building `/accounts/null`.
 */
export function resolveSwitcherAccountId({
  accounts,
  workspaces,
  activeWorkspaceId,
  selectedAccountId,
}: GroupWorkspacesInput & { selectedAccountId: string | null }): string | null {
  const activeWorkspace = activeWorkspaceId
    ? workspaces.find((workspace) => workspace.project_id === activeWorkspaceId)
    : undefined;
  return activeWorkspace?.account_id ?? selectedAccountId ?? accounts[0]?.account_id ?? null;
}

export type WorkspaceRowNavigation =
  { kind: 'switch'; href: string } | { kind: 'account-settings'; href: string };

/**
 * Where clicking a workspace row goes.
 *
 * The row you are already in cannot switch anywhere: `switchProject` returned
 * early on it, so the click spent the menu and did nothing. It is also the one
 * row in the product that unambiguously names an account you are a member of,
 * so it now opens that account's settings — the same destination as the
 * "Account settings" row at the top of this menu. Every other row keeps the
 * switch it always had.
 */
export function resolveWorkspaceRowNavigation(
  workspace: Pick<KortixProject, 'project_id' | 'account_id'>,
  activeWorkspaceId: string | null | undefined,
): WorkspaceRowNavigation {
  if (activeWorkspaceId && workspace.project_id === activeWorkspaceId) {
    return { kind: 'account-settings', href: `/accounts/${workspace.account_id}` };
  }
  return { kind: 'switch', href: `/projects/${workspace.project_id}` };
}

/**
 * Filter grouped workspaces by a free-text query.
 *
 * NEVER caps the result. The old switcher sliced to 8 because `/projects` was
 * the real directory; it is not any more, and a cap here silently hides
 * workspaces a user can otherwise reach. Render cost is handled by
 * virtualisation in the component, not by dropping data here.
 *
 * A match on the ACCOUNT name keeps that account's whole group, so "acme"
 * answers "show me everything in Acme" as well as "find a workspace".
 */
export function filterWorkspaceGroups(groups: WorkspaceGroup[], query: string): WorkspaceGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  const filtered: WorkspaceGroup[] = [];
  for (const group of groups) {
    if (group.accountName.toLowerCase().includes(needle)) {
      filtered.push(group);
      continue;
    }
    const workspaces = group.workspaces.filter((w) => w.name.toLowerCase().includes(needle));
    if (workspaces.length > 0) filtered.push({ ...group, workspaces });
  }
  return filtered;
}
