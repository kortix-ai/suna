'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import { OutputBlock } from '@/features/session/tool/shared/output-block';
import {
  Folder,
} from 'lucide-react';
import {
  useMemo,
} from 'react';


import {
  type ProjectEntry,
  parseProjectListOutput,
} from '@/lib/utils/kortix-tool-output';

export function ProjectListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const output = partOutput(part);
  const projects = useMemo(() => parseProjectListOutput(output || ''), [output]);

  return (
    <BasicTool
      icon={<Folder />}
      trigger={{
        title: 'Workspace',
        subtitle: projects.length > 0 ? 'global workspace' : undefined,
      }}
      defaultOpen={defaultOpen || projects.length === 0}
      forceOpen={forceOpen}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="project_list" />
      ) : projects.length > 0 ? (
        <div className="space-y-0.5">
          {projects.map((project: ProjectEntry) => (
            <div
              key={project.path}
              className="text-muted-foreground/70 flex items-center gap-1.5 py-0.5 text-xs"
            >
              <Folder className="text-muted-foreground/50 size-3.5 flex-shrink-0" />
              <span className="truncate">{project.name}</span>
              <span className="text-muted-foreground/40 truncate font-mono text-xs">
                {project.path}
              </span>
            </div>
          ))}
        </div>
      ) : output ? (
        <OutputBlock text={output.slice(0, 2000)} />
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('project_list', ProjectListTool);
ToolRegistry.register('project-list', ProjectListTool);
ToolRegistry.register('oc-project_list', ProjectListTool);
ToolRegistry.register('oc-project-list', ProjectListTool);

