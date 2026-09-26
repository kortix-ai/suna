import type { KortixAccount, KortixProject, MyAccountInvite } from '@kortix/sdk';

import { workspaceAccountLabel } from '@/features/workspace/project-sidebar/workspace-grouping';

/**
 * The pure half of `/projects`, the project selector.
 *
 * `/projects` is the Slack-style "choose a workspace" step: create a project,
 * join an invite, or open a project in any account the user belongs to. This
 * module turns the raw reads (accounts, one project list per account, pending
 * invites) into the sections the page renders, so every user state is
 * decided in one tested place:
 *
 *  - new user            — no project anywhere, no invite: the create card only.
 *  - invited             — pending invites, each with Join, above everything.
 *  - account member      — member of an account that shares no project with
 *                          them: the account is listed with an "ask an admin"
 *                          line, never silently dropped.
 *  - project member      — sees exactly the projects granted to them, grouped
 *                          under the owning account.
 *  - owner / admin       — every project in the account, plus a create row
 *                          for an account that has none yet.
 */

/** Rows shown per account before "Show all". */
export const COLLAPSED_PROJECT_LIMIT = 5;

/** The search field appears once the full list stops fitting on one screen. */
export const SEARCH_THRESHOLD = 8;

export type AccountSectionState =
  /** The account lists at least one project for this user. */
  | 'projects'
  /** No project yet, and the user may create one here. */
  | 'empty-creatable'
  /** No project shared with this user, and they may not create one. */
  | 'empty-member'
  /** The project list request failed. */
  | 'failed';

export interface AccountSection {
  accountId: string;
  accountName: string;
  role: KortixAccount['account_role'];
  canCreate: boolean;
  state: AccountSectionState;
  /** Most recently opened first. Empty unless `state === 'projects'`. */
  projects: KortixProject[];
}

export interface ProjectListResult {
  accountId: string;
  data: KortixProject[] | undefined;
  isError: boolean;
}

/** Owners and admins hold `ACCOUNT_ACTIONS.PROJECT_CREATE`; members get `403`. */
export function canCreateInAccount(account: Pick<KortixAccount, 'account_role'>): boolean {
  return account.account_role === 'owner' || account.account_role === 'admin';
}

function openedAt(project: KortixProject): number {
  return project.last_opened_at ? new Date(project.last_opened_at).getTime() : 0;
}

function sortByRecent(projects: KortixProject[]): KortixProject[] {
  return [...projects].sort(
    (a, b) => openedAt(b) - openedAt(a) || a.name.localeCompare(b.name),
  );
}

const STATE_ORDER: Record<AccountSectionState, number> = {
  projects: 0,
  'empty-creatable': 1,
  'empty-member': 2,
  failed: 3,
};

/**
 * One section per account the user belongs to.
 *
 * Order: accounts with projects first, ranked by their most recently opened
 * project, so the account the user works in sits at the top. Empty and failed
 * accounts follow. A project whose account is missing from `accounts` (a
 * project shared into an account the user is not a member of) still gets a
 * section: the selector must never hide a project the user can open.
 */
export function buildAccountSections(input: {
  accounts: KortixAccount[];
  lists: ProjectListResult[];
}): AccountSection[] {
  const listByAccount = new Map(input.lists.map((list) => [list.accountId, list]));
  const projectsByAccount = new Map<string, KortixProject[]>();
  for (const list of input.lists) {
    for (const project of list.data ?? []) {
      if (project.status === 'archived') continue;
      const bucket = projectsByAccount.get(project.account_id);
      if (bucket) bucket.push(project);
      else projectsByAccount.set(project.account_id, [project]);
    }
  }

  const sections: AccountSection[] = input.accounts.map((account) => {
    const canCreate = canCreateInAccount(account);
    const projects = sortByRecent(projectsByAccount.get(account.account_id) ?? []);
    projectsByAccount.delete(account.account_id);
    const list = listByAccount.get(account.account_id);
    const state: AccountSectionState =
      projects.length > 0
        ? 'projects'
        : list?.isError
          ? 'failed'
          : canCreate
            ? 'empty-creatable'
            : 'empty-member';
    return {
      accountId: account.account_id,
      accountName: workspaceAccountLabel(account.name),
      role: account.account_role,
      canCreate,
      state,
      projects,
    };
  });

  for (const [accountId, projects] of projectsByAccount) {
    sections.push({
      accountId,
      accountName: workspaceAccountLabel(null),
      role: 'member',
      canCreate: false,
      state: 'projects',
      projects: sortByRecent(projects),
    });
  }

  return sections.sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    return latestOpenedAt(b) - latestOpenedAt(a);
  });
}

function latestOpenedAt(section: AccountSection): number {
  const first = section.projects[0];
  return first ? openedAt(first) : 0;
}

/** Case-insensitive match on the project name and the account name. */
export function filterSections(sections: AccountSection[], query: string): AccountSection[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sections;
  return sections.flatMap((section) => {
    if (section.state !== 'projects') return [];
    const accountHit = section.accountName.toLowerCase().includes(needle);
    const projects = accountHit
      ? section.projects
      : section.projects.filter((project) => project.name.toLowerCase().includes(needle));
    return projects.length > 0 ? [{ ...section, projects }] : [];
  });
}

export function countProjects(sections: AccountSection[]): number {
  return sections.reduce((total, section) => total + section.projects.length, 0);
}

/**
 * Where Join goes. A project invite opens the first invited project. A plain
 * workspace invite has no project yet, so the caller stays on the selector
 * and the refreshed lists show the joined account.
 */
export function joinDestination(invite: MyAccountInvite): string | null {
  const first = invite.projects[0];
  return first ? `/projects/${first.project_id}` : null;
}

/**
 * `/projects/start` — open a project directly, or show the selector.
 *
 * The selector is skipped only when there is exactly one obvious answer:
 *  - the project the browser last had open still exists, or
 *  - the user has exactly one project in total.
 * A pending invite always shows the selector, so an invite is never skipped
 * past on the way into a project.
 */
export type DoorDecision = { kind: 'open'; projectId: string; accountId: string } | { kind: 'select' };

export function decideDoor(input: {
  sections: AccountSection[];
  inviteCount: number;
  rememberedProjectId: string | null;
}): DoorDecision {
  if (input.inviteCount > 0) return { kind: 'select' };
  const all = input.sections.flatMap((section) => section.projects);
  if (input.rememberedProjectId) {
    const remembered = all.find((project) => project.project_id === input.rememberedProjectId);
    if (remembered) {
      return { kind: 'open', projectId: remembered.project_id, accountId: remembered.account_id };
    }
  }
  if (all.length === 1) {
    return { kind: 'open', projectId: all[0].project_id, accountId: all[0].account_id };
  }
  return { kind: 'select' };
}
