'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import {
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';


export function TaskDeleteTool({ part, forceOpen }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const output = partOutput(part);
  const status = partStatus(part);
  const isError = status === 'completed' && isErrorOutput(output);

  return (
    <BasicTool
      icon={<Trash2 className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Delete task', subtitle: isError ? 'failed' : undefined }}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="task_delete" />
      ) : (
        <div className="text-muted-foreground px-3 py-2 text-xs leading-relaxed">
          {tHardcodedUi.raw('componentsSessionToolRenderers.line6903JsxTextTaskRemoved')}
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('task_delete', TaskDeleteTool);
ToolRegistry.register('task-delete', TaskDeleteTool);

function extractSkillContent(output: string): string {
  const match = output.match(/<skill_content[^>]*>([\s\S]*?)<\/skill_content>/);
  return match ? match[1].trim() : output;
}

function extractSkillFiles(output: string): string[] {
  const filesMatch = output.match(/<skill_files>([\s\S]*?)<\/skill_files>/);
  if (!filesMatch) return [];
  const fileRegex = /<file>(.*?)<\/file>/g;
  const files: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fileRegex.exec(filesMatch[1])) !== null) {
    files.push(m[1].trim());
  }
  return files;
}

