'use client';

import { FolderOpen, User, Archive } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspaces, findWorkspaceForPath, type Workspace } from '../hooks/use-workspaces';

interface Props {
  currentPath: string;
  onSelect: (workspace: Workspace) => void;
}

export function WorkspacePicker({ currentPath, onSelect }: Props) {
  const { data: workspaces, isLoading } = useWorkspaces();
  const active = findWorkspaceForPath(workspaces, currentPath);

  if (isLoading || !workspaces || workspaces.length <= 1) return null;

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border/40 overflow-x-auto">
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/60 font-semibold mr-1 shrink-0">
        Workspaces
      </span>
      {workspaces.map((w) => {
        const isActive = active?.id === w.id;
        const Icon =
          w.kind === 'personal' ? User : w.kind === 'legacy' ? Archive : FolderOpen;
        return (
          <button
            key={w.id}
            onClick={() => onSelect(w)}
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] shrink-0 transition-colors cursor-pointer',
              isActive
                ? 'bg-primary/10 text-foreground ring-1 ring-primary/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
            title={w.path}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="truncate max-w-[200px]">{w.label}</span>
          </button>
        );
      })}
    </div>
  );
}
