import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { useIsMobile } from '@/hooks/utils';
import { relativeTime } from '@/lib/kortix/task-meta';
import type { KortixProject } from '@kortix/sdk';
import { ArrowUpRight, Pencil, TrashSolid } from '@mynaui/icons-react';
import { GitBranch, MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

const ProjectCard = ({
  project,
  onOpen,
  onRename,
  onArchive,
  archiving,
}: {
  project: KortixProject;
  onOpen: () => void;
  onRename: () => void;
  onArchive: () => void;
  archiving: boolean;
}) => {
  const isMobile = useIsMobile();
  const tHardcodedUi = useTranslations('hardcodedUi');
  const updatedLabel = relativeTime(project.updated_at);
  const canManageProject =
    project.effective_project_role === 'manager' || !project.effective_project_role;

  return (
    <Card className="group bg-secondary/80 hover:bg-secondary relative p-0 transition-[background-color,transform] duration-150 ease-out has-[[data-card-press]:active]:scale-[0.98]">
      <button
        type="button"
        data-card-press
        onClick={onOpen}
        className="w-full cursor-pointer px-5 py-4 text-left"
      >
        <div className="flex w-full items-center gap-3">
          <EntityAvatar label={project.name} size="lg" className="bg-background" />
          <div className="min-w-0 flex-1 space-y-1">
            <h3
              title={project.name}
              className="text-foreground truncate text-sm leading-tight font-semibold"
            >
              {project.name}
            </h3>
            <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <GitBranch className="size-3.5 shrink-0" />
                <span className="truncate font-mono">{project.default_branch}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="shrink-0 tabular-nums">Updated {updatedLabel}</span>
            </div>
          </div>
        </div>
      </button>

      <div className="absolute top-3 right-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <DropdownMenu>
          <Hint label="Project actions" side="top">
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-10"
                onClick={(e) => e.stopPropagation()}
                aria-label={tHardcodedUi.raw(
                  'appProjectsPage.line103JsxAttrAriaLabelProjectActions',
                )}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align={isMobile ? 'end' : 'start'} className="w-44">
            <DropdownMenuItem onSelect={onOpen}>
              <ArrowUpRight className="size-4" />
              {tHardcodedUi.raw('appProjectsPage.line109JsxTextOpenProject')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename} disabled={!canManageProject}>
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={onArchive}
              disabled={archiving || !canManageProject}
            >
              {archiving ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <TrashSolid className="size-4" />
              )}
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
};

export default ProjectCard;
