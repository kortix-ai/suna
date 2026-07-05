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
import Loading from '@/components/ui/loading';
import { useIsMobile } from '@/hooks/utils';
import { useProjectCan } from '@/lib/use-project-can';
import { relativeTime } from '@/lib/kortix/task-meta';
import { KortixProject } from '@kortix/sdk/projects-client';
import { ArrowUpRight, Pencil, TrashSolid } from '@mynaui/icons-react';
import { MoreHorizontal } from 'lucide-react';
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
  // Rename is editor-tier (project.write) — `editor` is the top project role
  // now that `manager` was retired; an unresolved role (null) defaults open,
  // matching the prior behavior.
  const canRename = project.effective_project_role === 'editor' || !project.effective_project_role;
  // Archive = project.delete, which the project-role collapse moved to
  // ACCOUNT owner/admin authority only — no project role (not even editor)
  // grants it anymore. Probe the live capability instead of the role label so
  // the button isn't shown to someone who'd just get 403'd.
  const canArchive = useProjectCan(project.project_id, 'project.delete', {
    accountId: project.account_id,
  }).allowed;

  return (
    <Card className="group bg-secondary/80 hover:bg-secondary relative p-0 transition-[background-color,transform] duration-150 ease-out has-[[data-card-press]:active]:scale-[0.98]">
      <button
        type="button"
        data-card-press
        onClick={onOpen}
        className="cursor-pointer px-5 py-4 text-left"
      >
        <div className="flex w-full items-center gap-3">
          <EntityAvatar label={project.name} size="lg" className="bg-background" />
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-foreground truncate text-sm leading-tight font-semibold">
              {project.name}
            </h3>
            <p className="text-muted-foreground truncate text-xs">Updated {updatedLabel}</p>
          </div>
        </div>
      </button>

      <div className="absolute top-3 right-3 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => e.stopPropagation()}
              aria-label={tHardcodedUi.raw('appProjectsPage.line103JsxAttrAriaLabelProjectActions')}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={isMobile ? 'end' : 'start'} className="w-44">
            <DropdownMenuItem onSelect={onOpen}>
              <ArrowUpRight className="size-4" />
              {tHardcodedUi.raw('appProjectsPage.line109JsxTextOpenProject')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename} disabled={!canRename}>
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={onArchive}
              disabled={archiving || !canArchive}
            >
              {archiving ? <Loading /> : <TrashSolid className="size-4" />}
              Archive
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  );
};

export default ProjectCard;
