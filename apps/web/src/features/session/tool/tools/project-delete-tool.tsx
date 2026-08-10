'use client';
import { BasicTool, partInput } from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { TrashIcon as Trash2 } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';

export function WorkspaceDeleteTool({ part }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const project = (input.workspace as string) || '';
  return (
    <BasicTool
      icon={<Trash2 className="text-muted-foreground/40 size-3.5 shrink-0" />}
      trigger={{
        title: 'Workspace',
        subtitle: tHardcodedUi.raw(
          'componentsSessionToolRenderers.line6211JsxTextWorkspaceDeleteDisabled',
        ),
        args: project ? [project] : undefined,
      }}
    />
  );
}
ToolRegistry.register('project_delete', WorkspaceDeleteTool);
ToolRegistry.register('project-delete', WorkspaceDeleteTool);
ToolRegistry.register('oc-project_delete', WorkspaceDeleteTool);
ToolRegistry.register('oc-project-delete', WorkspaceDeleteTool);

function cleanWorkerOutput(raw: string): string {
  if (!raw) return '';
  let text = raw;

  text = text.replace(/^##\s*Worker Result\s*\n/i, '');
  text = text.replace(/^\*\*Agent:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Task:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Status:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Session:\*\*.*\n?/m, '');
  text = text.replace(/^\*\*Duration:\*\*.*\n?/m, '');

  text = text.replace(/<kortix_goal_system[^>]*>[\s\S]*?<\/kortix_goal_system>/g, '');

  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* created and started\..*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* created:.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* started\..*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* failed to start.*$/gm, '');
  text = text.replace(/^Message sent to task.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* approved.*$/gm, '');
  text = text.replace(/^Task \*\*task-[a-z0-9]+\*\* cancelled.*$/gm, '');
  text = text.replace(/Worker session: ses_[a-zA-Z0-9]+/g, '');

  text = text.replace(/^---\s*\n/gm, '');
  text = text.trim();
  return text || '';
}

function isShortOutput(cleaned: string): boolean {
  if (!cleaned) return false;
  const lines = cleaned.split('\n').filter((l) => l.trim());
  return lines.length <= 3;
}

function extractWorkerPreview(cleaned: string): string | null {
  if (!cleaned) return null;

  const lines = cleaned.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const first = lines[0]?.replace(/^\*\*.*?\*\*\s*/, '').trim();
  if (!first) return null;
  return first.length > 120 ? first.slice(0, 120).trim() + '…' : first;
}
