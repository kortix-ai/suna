'use client';

import { Badge } from '@/components/ui/badge';
import type { KortixProject } from '@kortix/sdk';
import { Github } from 'lucide-react';

import ProjectCard from './project-card';
import { groupProjectsByRepository } from './project-repository-groups';

export function ProjectRepositoryGroups({
  projects,
  archivingId,
  onOpen,
  onRename,
  onArchive,
}: {
  projects: readonly KortixProject[];
  archivingId: string | null;
  onOpen: (project: KortixProject) => void;
  onRename: (project: KortixProject) => void;
  onArchive: (project: KortixProject) => void;
}) {
  return (
    <div className="space-y-8">
      {groupProjectsByRepository(projects).map((group) => (
        <section
          key={group.key}
          className="space-y-3"
          data-testid="project-repository-group"
          data-repository={group.key}
        >
          <header className="flex min-w-0 items-center gap-2.5">
            <span className="bg-muted text-muted-foreground inline-flex size-9 shrink-0 items-center justify-center rounded-md border">
              <Github className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-foreground truncate text-sm font-semibold tracking-tight">
                {group.label}
              </h2>
              <p className="text-muted-foreground text-xs">
                {group.projects.length === 1
                  ? '1 project'
                  : `${group.projects.length} isolated projects`}
              </p>
            </div>
            {group.projects.length > 1 ? (
              <Badge variant="outline" size="xs" className="shrink-0 tabular-nums">
                {group.projects.length}
              </Badge>
            ) : null}
          </header>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.projects.map((project) => (
              <ProjectCard
                key={project.project_id}
                project={project}
                onOpen={() => onOpen(project)}
                onRename={() => onRename(project)}
                onArchive={() => onArchive(project)}
                archiving={archivingId === project.project_id}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
