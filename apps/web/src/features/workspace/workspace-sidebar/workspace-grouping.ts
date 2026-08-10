import type { KortixAccount, KortixWorkspace } from '@kortix/sdk';

/**
 * The switcher menu is the only complete workspace directory in the product —
 * the `/workspaces` index that used to hold that job is gone. So this grouping is
 * the whole navigation model, not a convenience view, and it must never drop a
 * workspace the user can reach.
 *
 * That is why an orphan workspace (one whose account is missing from
 * `accounts`, e.g. a shared project in an account the user is not a member of)
 * still gets a group rather than being filtered out.
 */

/** Shown when an account has no usable name. Never blank. */
const FALLBACK_ACCOUNT_NAME = 'Account';

export interface WorkspaceGroup {
  accountId: string;
  accountName: string;
  workspaces: KortixWorkspace[];
}

export interface GroupWorkspacesInput {
  accounts: Pick<KortixAccount, 'account_id' | 'name'>[];
  workspaces: KortixWorkspace[];
  /** The workspace currently open, if any. Its account sorts first. */
  activeWorkspaceId: string | null | undefined;
}

function openedAt(workspace: KortixWorkspace): number {
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

  const byAccountId = new Map<string, KortixWorkspace[]>();
  for (const workspace of workspaces) {
    const bucket = byAccountId.get(workspace.account_id);
    if (bucket) bucket.push(workspace);
    else byAccountId.set(workspace.account_id, [workspace]);
  }

  const activeAccountId =
    workspaces.find((workspace) => workspace.workspace_id === activeWorkspaceId)?.account_id ?? null;

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
 * Filter grouped workspaces by a free-text query.
 *
 * NEVER caps the result. The old switcher sliced to 8 because `/workspaces` was
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
