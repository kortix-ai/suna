'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CornerDownLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  CommandPopover,
  CommandPopoverTrigger,
  CommandPopoverContent,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandFooter,
} from '@/components/ui/command';
import {
  useKortixProjects,
  type KortixProject,
} from '@/hooks/kortix/use-kortix-projects';
import { openTabAndNavigate } from '@/stores/tab-store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function projectRecency(p: KortixProject): number {
  if (p.time?.updated) return p.time.updated;
  if (p.created_at) {
    const t = new Date(p.created_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function shortPath(path: string | undefined): string {
  if (!path || path === '/') return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface ProjectSelectorProps {
  /** Selected project id, or null for "default / no override". */
  selectedProjectId: string | null;
  /** Fires with the new project id, or null to clear the selection. */
  onSelect: (projectId: string | null) => void;
}

export function ProjectSelector({
  selectedProjectId,
  onSelect,
}: ProjectSelectorProps) {
  const { data: projects, isLoading } = useKortixProjects();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  // Reset search when closing
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  // Sort by recency (desc)
  const sorted = useMemo(() => {
    if (!projects) return [] as KortixProject[];
    return [...projects].sort((a, b) => projectRecency(b) - projectRecency(a));
  }, [projects]);

  // Filter by search query
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((p) => {
      const hay = [p.name, p.path, p.description, p.id].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [sorted, search]);

  const selected = useMemo(
    () => sorted.find((p) => p.id === selectedProjectId) ?? null,
    [sorted, selectedProjectId],
  );

  const displayName = selected?.name ?? 'Default project';
  const hasProjects = sorted.length > 0;

  const handleOpenProject = (project: KortixProject) => {
    openTabAndNavigate({
      id: `project:${project.id}`,
      title: project.name,
      type: 'project',
      href: `/projects/${encodeURIComponent(project.id)}`,
    });
    setOpen(false);
  };

  return (
    <div className="mx-auto w-full max-w-[52rem] px-2 sm:px-4 pb-1.5 flex items-center justify-center">
      <CommandPopover open={open} onOpenChange={setOpen} modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <CommandPopoverTrigger>
              <button
                type="button"
                disabled={isLoading && !hasProjects}
                className={cn(
                  'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-xl',
                  'text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted',
                  'transition-colors duration-200 cursor-pointer',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  open && 'bg-muted text-foreground',
                  selected && 'text-foreground',
                )}
              >
                <span className="truncate max-w-[180px] sm:max-w-[260px]">
                  {displayName}
                </span>
                <ChevronDown
                  className={cn(
                    'size-3 opacity-50 transition-transform duration-200',
                    open && 'rotate-180',
                  )}
                />
              </button>
            </CommandPopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <p>Choose project for this session</p>
          </TooltipContent>
        </Tooltip>

        <CommandPopoverContent
          side="top"
          align="center"
          sideOffset={8}
          className="w-[340px]"
        >
          <CommandInput
            compact
            placeholder="Search projects..."
            value={search}
            onValueChange={setSearch}
          />

          <CommandList className="max-h-[340px]">
            {/* Default (no override) option — always visible, unfiltered */}
            {!search.trim() && (
              <CommandGroup forceMount>
                <CommandItem
                  value="project-default"
                  onSelect={() => {
                    onSelect(null);
                    setOpen(false);
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <span className="font-medium truncate">Default project</span>
                    <p className="text-[11px] text-muted-foreground/50 leading-snug mt-0.5 line-clamp-1">
                      Use the current working directory
                    </p>
                  </div>
                  {!selectedProjectId && (
                    <Check className="size-3.5 text-foreground shrink-0" />
                  )}
                </CommandItem>
              </CommandGroup>
            )}

            {filtered.length > 0 && (
              <CommandGroup heading="Recent projects" forceMount>
                {filtered.map((project) => {
                  const isSelected = selectedProjectId === project.id;
                  const recency = projectRecency(project);
                  const pathLabel = shortPath(project.path);
                  const relLabel = recency > 0 ? formatRelativeTime(recency) : '';
                  const subtitleParts = [pathLabel, relLabel].filter(Boolean);
                  return (
                    <CommandItem
                      key={project.id}
                      value={`project-${project.id}-${project.name}`}
                      onSelect={() => {
                        onSelect(project.id);
                        setOpen(false);
                      }}
                      className="group"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-medium truncate">{project.name}</span>
                        {subtitleParts.length > 0 && (
                          <p className="text-[11px] text-muted-foreground/50 leading-snug mt-0.5 line-clamp-1">
                            {subtitleParts.join(' · ')}
                          </p>
                        )}
                      </div>
                      <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Open ${project.name} page`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleOpenProject(project);
                        }}
                        className={cn(
                          'text-[11px] font-medium whitespace-nowrap shrink-0',
                          'px-1.5 py-0.5 rounded-md cursor-pointer',
                          'text-muted-foreground/70 hover:text-foreground hover:bg-muted',
                          'opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100',
                          'transition-opacity duration-150',
                        )}
                      >
                        Open ↗
                      </span>
                      {isSelected && (
                        <Check className="size-3.5 text-foreground shrink-0" />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {/* Empty states */}
            {filtered.length === 0 && search.trim() && (
              <div className="py-8 text-center text-xs text-muted-foreground/50">
                No projects match &ldquo;{search.trim()}&rdquo;
              </div>
            )}
            {!hasProjects && !search.trim() && !isLoading && (
              <div className="py-6 text-center text-xs text-muted-foreground/50">
                No projects yet
              </div>
            )}
          </CommandList>

          <CommandFooter>
            <div className="flex items-center gap-1">
              <ArrowUp className="h-3 w-3" />
              <ArrowDown className="h-3 w-3" />
              <span>navigate</span>
            </div>
            <div className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" />
              <span>select</span>
            </div>
          </CommandFooter>
        </CommandPopoverContent>
      </CommandPopover>
    </div>
  );
}
