import type { KortixProject } from '@kortix/sdk';

import {
  SECTION_FOR_ACCOUNT_TAB,
  projectAdminHref,
} from '../../customize/project-settings/project-admin-sections';
import { adminPath } from '../../lib/routes';
import { hubDrillDownParams, type HubTarget } from '../stores/account-panel-store';
import { parseAccountSection } from './sections';

/**
 * The account hub is a router now (Workspaces ux.md section 4): every place in
 * it — `?accountId=<a>&accountTab=<t>` on an old link, or a `hubTarget()` a
 * pane still opens — is a section of the workspace's settings,
 * `/projects/<id>/admin/<section>`.
 */

/** The workspace page a hub place opens, for the workspace `projectId`. */
export function workspaceSettingsHref(projectId: string, target: HubTarget): string {
  const tab = parseAccountSection(target.params.tab);
  const query = Object.fromEntries(hubDrillDownParams(target).entries());
  if (!tab) {
    const search = new URLSearchParams(query).toString();
    return `${adminPath(projectId)}${search ? `?${search}` : ''}`;
  }
  return projectAdminHref(projectId, SECTION_FOR_ACCOUNT_TAB[tab], query);
}

function openedAt(project: KortixProject): number {
  return project.last_opened_at ? new Date(project.last_opened_at).getTime() : 0;
}

/**
 * The workspace of `accountId` an account-level link means: the workspace on
 * screen when it belongs to that account (the "current workspace"), else the
 * account's most recently opened active project. `null`: the account has no
 * workspace the caller can open, or its list is not known yet.
 */
export function pickWorkspaceForAccount(input: {
  accountId: string;
  routeProjectId: string | null;
  /** The route project's account, when its row is known. */
  routeProjectAccountId: string | null;
  /** The account's project list, when known. */
  projects: KortixProject[] | undefined;
}): string | null {
  if (!input.accountId) return null;
  if (input.routeProjectId && input.routeProjectAccountId === input.accountId) return input.routeProjectId;
  const active = (input.projects ?? []).filter(
    (project) => project.status !== 'archived' && project.account_id === input.accountId,
  );
  if (input.routeProjectId && active.some((project) => project.project_id === input.routeProjectId)) {
    return input.routeProjectId;
  }
  const recent = [...active].sort((a, b) => openedAt(b) - openedAt(a))[0];
  return recent?.project_id ?? null;
}

/** The project id of a `/projects/<id>/…` path, or null. */
export function routeProjectIdOf(pathname: string | null | undefined): string | null {
  const match = /^\/(?:[a-z]{2}\/)?projects\/([^/?#]+)/.exec(pathname ?? '');
  const id = match?.[1];
  return id && id !== 'start' ? decodeURIComponent(id) : null;
}
