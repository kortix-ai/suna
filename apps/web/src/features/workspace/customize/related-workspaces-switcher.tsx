'use client';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { groupWorkspacesByRepository } from '@/features/workspaces/workspace-repository-groups';
import type { KortixWorkspace } from '@kortix/sdk';
import { listWorkspacesForAccount } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';

export function RelatedWorkspacesSwitcher({ workspace }: { workspace: KortixWorkspace }) {
  const router = useRouter();
  const workspacesQuery = useQuery({
    queryKey: qk.workspaces.list(workspace.account_id),
    queryFn: () => listWorkspacesForAccount(workspace.account_id),
    ...contract('inventory'),
  });
  const related =
    groupWorkspacesByRepository(workspacesQuery.data ?? []).find((group) =>
      group.workspaces.some((candidate) => candidate.workspace_id === workspace.workspace_id),
    )?.workspaces ?? [];

  if (related.length < 2) return null;

  return (
    <div className="mt-5 space-y-1.5 px-2.5" data-testid="related-workspaces-switcher">
      <Label className="text-muted-foreground px-2">Related workspaces</Label>
      <Select
        value={workspace.workspace_id}
        onValueChange={(nextWorkspaceId) => router.push(`/workspaces/${nextWorkspaceId}`)}
      >
        <SelectTrigger className="h-auto min-h-10 w-full px-3 py-2">
          <span className="min-w-0 text-left">
            <span className="text-foreground block truncate text-sm font-medium">
              {workspace.name}
            </span>
            <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{workspace.default_branch}</span>
            </span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {related.map((candidate) => (
            <SelectItem key={candidate.workspace_id} value={candidate.workspace_id}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{candidate.name}</span>
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {candidate.default_branch}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
