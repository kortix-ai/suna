'use client';

/**
 * Workspace settings › People › Access: who can open this workspace, and with
 * which role. It is the account hub's former "Projects" tab.
 *
 * OPEN DECISION D5 (`.agents/skills/learnings/work/workspaces/decisions.md`):
 * does joining a workspace grant access to it? Until Marko answers, account
 * membership and project access stay two grants, and this section keeps the
 * project-access table. Everything D5 can change lives in this one file:
 *
 *  - an account with exactly one project (every new workspace) shows that
 *    project's access table directly: there is nothing to pick;
 *  - a legacy account with several projects keeps the project picker.
 *
 * If D5 lands as proposed (an invite carries the project grant, Members shows
 * each person's project role), this section folds into Members and the
 * `access` row leaves the rail.
 */

import { listProjectsForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

import { Skeleton } from '@kortix/ui/skeleton';
import { AccessProjectsTab, ProjectAccessPanel } from '@/components/iam/access-projects-tab';
import { useTranslations } from '@/i18n/use-translations';

export function WorkspaceAccessSection({
  accountId,
  selectedProjectId,
  onSelectProject,
  rbacEnabled,
  canManageRoles,
}: {
  accountId: string;
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  rbacEnabled: boolean;
  canManageRoles: boolean;
}) {
  const t = useTranslations('workspaces.settings');
  // The same key and contract as the picker's own list: one request.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
  });
  const active = (projectsQuery.data ?? []).filter((project) => project.status !== 'archived');

  if (projectsQuery.isLoading) {
    return <Skeleton className="h-64 w-full rounded-md" />;
  }

  if (active.length === 1 && active[0]) {
    return (
      <ProjectAccessPanel
        key={active[0].project_id}
        accountId={accountId}
        projectId={active[0].project_id}
        rbacEnabled={rbacEnabled}
        canManageRoles={canManageRoles}
        heading={
          <>
            <h1 className="text-foreground text-2xl font-medium tracking-tight text-balance">
              {t('accessTitle')}
            </h1>
            <p className="text-muted-foreground text-sm text-pretty">{t('accessDescription')}</p>
          </>
        }
      />
    );
  }

  return (
    <AccessProjectsTab
      accountId={accountId}
      selectedProjectId={selectedProjectId}
      onSelectProject={onSelectProject}
      rbacEnabled={rbacEnabled}
      canManageRoles={canManageRoles}
    />
  );
}
