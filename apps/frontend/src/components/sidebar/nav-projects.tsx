'use client';

import { useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Plus, FolderOpen, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSidebar } from '@/components/ui/sidebar';
import { useProjects } from '@/hooks/sidebar/use-sidebar';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import posthog from 'posthog-js';

export function NavProjects() {
  const { isMobile, setOpenMobile } = useSidebar();
  const router = useRouter();
  const pathname = usePathname();
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);

  const {
    data: projects = [],
    isLoading,
    error
  } = useProjects();

  // Get unique projects (max 5 for sidebar display)
  const displayedProjects = projects.slice(0, 5);

  const handleNewProject = () => {
    posthog.capture('new_project_clicked', { source: 'sidebar' });
    setShowNewProjectDialog(true);
  };

  const handleNavigation = (path: string) => {
    router.push(path);
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <div className="mt-6 px-1">
      {/* Section Header */}
      <div className="flex items-center justify-between mb-2 px-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Projects
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 hover:bg-accent"
              onClick={handleNewProject}
            >
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">New project</TooltipContent>
        </Tooltip>
      </div>

      {/* Projects List */}
      <div className="space-y-0.5">
        {isLoading ? (
          // Skeleton loading state
          <div className="space-y-1">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={`skeleton-${index}`} className="flex items-center gap-2.5 px-3 py-2">
                <div className="h-4 w-4 bg-muted/30 rounded animate-pulse"></div>
                <div className="h-3 bg-muted/30 rounded flex-1 animate-pulse"></div>
              </div>
            ))}
          </div>
        ) : displayedProjects.length > 0 ? (
          displayedProjects.map((project) => {
            const isActive = pathname?.includes(`/projects/${project.project_id}`);
            
            return (
              <Link
                key={project.project_id}
                href={`/projects/${project.project_id}`}
                onClick={() => isMobile && setOpenMobile(false)}
                className={cn(
                  "group flex items-center gap-2.5 px-3 py-2 rounded-xl transition-all text-[13px]",
                  isActive
                    ? "bg-accent text-accent-foreground font-medium"
                    : "hover:bg-accent/50 text-foreground/80 hover:text-foreground"
                )}
              >
                <FolderOpen className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="truncate flex-1">{project.name}</span>
              </Link>
            );
          })
        ) : (
          // Empty state
          <div className="px-3 py-3 text-center">
            <p className="text-xs text-muted-foreground/60">
              No projects yet
            </p>
          </div>
        )}

        {/* View all projects link */}
        {projects.length > 5 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start h-8 px-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => handleNavigation('/projects')}
          >
            <ChevronRight className="h-3.5 w-3.5 mr-2" />
            View all ({projects.length})
          </Button>
        )}
      </div>

      {/* New Project Dialog */}
      <NewAgentDialog
        open={showNewProjectDialog}
        onOpenChange={setShowNewProjectDialog}
      />
    </div>
  );
}

