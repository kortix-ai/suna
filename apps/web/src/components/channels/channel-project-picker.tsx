"use client";

import React from 'react';
import { Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useKortixProjects } from '@/hooks/kortix/use-kortix-projects';

const WORKSPACE_OPTION = '__workspace__';

interface ChannelProjectPickerProps {
  /** Current project id, or null for workspace-scoped. */
  value: string | null;
  /** Called with the new project id (null = workspace). */
  onChange: (projectId: string | null) => void;
  className?: string;
}

/**
 * Project selector for channels. The "Workspace" option means the channel
 * is global (no project_id) and dispatches against opencode's workspace
 * agent set (kortix, general, …). Picking a project scopes the dispatch
 * to that project's working directory so per-project agents (engineer,
 * qa, tech-lead, …) become discoverable.
 */
export function ChannelProjectPicker({ value, onChange, className }: ChannelProjectPickerProps) {
  const { data: projects = [], isLoading } = useKortixProjects();

  const visibleProjects = projects.filter((p) => p.id !== 'proj-workspace');

  const handleChange = (next: string) => {
    onChange(next === WORKSPACE_OPTION ? null : next);
  };

  return (
    <Select value={value ?? WORKSPACE_OPTION} onValueChange={handleChange}>
      <SelectTrigger className={className}>
        <SelectValue>
          {isLoading ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading projects…
            </span>
          ) : value ? (
            visibleProjects.find((p) => p.id === value)?.name ?? value
          ) : (
            'Workspace (no project)'
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={WORKSPACE_OPTION}>
          <div className="flex flex-col">
            <span className="text-sm font-medium">Workspace</span>
            <span className="text-[11px] text-muted-foreground">Global agents (kortix, general, …)</span>
          </div>
        </SelectItem>
        {visibleProjects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-[11px] text-muted-foreground">{p.path}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
