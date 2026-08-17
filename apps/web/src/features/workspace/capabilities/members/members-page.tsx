'use client';

import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { useStandaloneCapabilityNav } from '@/features/workspace/capabilities/shared/standalone-settings-nav';
import { MembersTab as MembersTabPane } from '@/features/workspace/settings/tabs/members-tab';
import { SettingsNavProvider } from '@/features/workspace/shared/settings-nav-context';

/**
 * The page body for /projects/[id]/members — Members graduated out of the
 * project Settings sub-nav into its own top-level Customize tab, alongside
 * Connectors / Agents / Skills / Triggers / Models / Channels / Secrets.
 * "Who can reach this workspace, and what each person can do" is not a
 * configuration detail the way General/Sandbox/Feature-flags are; it is one
 * of the first things a project needs.
 *
 * `MembersTabPane` calls `useSettingsNav()` internally (e.g. cross-links to
 * Groups/Roles, which now live on the account settings page), which throws
 * outside a provider — `useStandaloneCapabilityNav` is that provider's value
 * for a page that is not the overlay or `/config`. `accountId` is resolved
 * here the same way `project-settings-page.tsx` resolves it for the same
 * component.
 */
export function MembersPage({ projectId }: { projectId: string }) {
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    enabled: !!projectId,
    ...contract('config'),
  });

  const settingsNav = useStandaloneCapabilityNav(projectId, 'members');

  return (
    <SettingsNavProvider value={settingsNav}>
      <MembersTabPane projectId={projectId} accountId={detail.data?.project.account_id} />
    </SettingsNavProvider>
  );
}
