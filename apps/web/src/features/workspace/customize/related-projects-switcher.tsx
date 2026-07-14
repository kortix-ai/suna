'use client';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { groupProjectsByRepository } from '@/features/projects/project-repository-groups';
import type { KortixProject } from '@kortix/sdk';
import { listProjectsForAccount } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function RelatedProjectsSwitcher({ project }: { project: KortixProject }) {
  const router = useRouter();
  const projectsQuery = useQuery({
    queryKey: ['projects', project.account_id],
    queryFn: () => listProjectsForAccount(project.account_id),
    staleTime: 20_000,
  });
  const related =
    groupProjectsByRepository(projectsQuery.data ?? []).find((group) =>
      group.projects.some((candidate) => candidate.project_id === project.project_id),
    )?.projects ?? [];

  if (related.length < 2) return null;

  return (
    <div className="mt-5 space-y-1.5 px-2.5" data-testid="related-projects-switcher">
      <Label className="text-muted-foreground px-2">Related projects</Label>
      <Select
        value={project.project_id}
        onValueChange={(nextProjectId) => router.push(`/projects/${nextProjectId}`)}
      >
        <SelectTrigger className="h-auto min-h-10 w-full px-3 py-2">
          <span className="min-w-0 text-left">
            <span className="text-foreground block truncate text-sm font-medium">
              {project.name}
            </span>
            <span className="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate font-mono">{project.default_branch}</span>
            </span>
          </span>
        </SelectTrigger>
        <SelectContent>
          {related.map((candidate) => (
            <SelectItem key={candidate.project_id} value={candidate.project_id}>
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
