'use client';

import type { WorkspaceAccountPane as WorkspaceAccountPaneComponent } from '@kortix/ui/workspace/admin/project-admin-dashboard';

import { AccountHubContent } from '@/features/accounts/hub/account-hub-content';

/**
 * The account panes of Workspace settings (People, Billing, Branding, API
 * keys, and the account halves of General and Git repo). The dashboard has
 * already named the account and the section (`EmbeddedAccountHubProvider`),
 * so the pane reads them the way it always read the hub URL.
 */
export const WorkspaceAccountPane: WorkspaceAccountPaneComponent = ({ companion, title }) => (
  <AccountHubContent companion={companion} title={title} />
);
