'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Separator } from '@/components/ui/separator';
import {
  BasicTool,
  MD_FLUSH_CLASSES,
  parseJsonFailure,
  partInput,
  partOutput,
  partStatus,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import {
  extractSkillContent,
  extractSkillFiles,
  skillDocumentPath,
} from '@/features/session/tool/shared/skill-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { FileDashedIcon, FileTextIcon as FileText } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';

export function SkillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const skillName = (input.name as string) || 'skill';
  const skillDir = (input.dir as string) || '';

  const skillContent = useMemo(() => extractSkillContent(output), [output]);
  const skillFiles = useMemo(() => extractSkillFiles(output), [output]);

  const markdownContent = useMemo(() => {
    return skillContent
      .replace(/<skill_files>[\s\S]*?<\/skill_files>/, '')
      .replace(/Base directory:.*$/m, '')
      .replace(/Note:.*relative to the base directory.*$/m, '')
      .trim();
  }, [skillContent]);

  /**
   * A skill opens where a file opens.
   *
   * This used to raise its own right-hand `Sheet` — a second overlay with its
   * own header, its own scroll and its own copy of the markdown, sitting on top
   * of the panel that already exists for exactly this. Clicking a file in a read
   * row puts it in the session's detail view; a skill is a document in the
   * project like any other, so it goes to the same place.
   */
  const openPreview = useFilePreviewStore((s) => s.openPreview);
  /**
   * The document behind the row, or null when the call did not say where it is.
   *
   * Resolved from the OUTPUT as well as the input: `input.dir` is not
   * dependable — the skill tool lives in the OpenCode runtime, not here, and a
   * call can arrive with only a name. Keying the click off `dir` alone left the
   * row silently doing nothing. See `skillDocumentPath`.
   */
  const docPath = useMemo(() => skillDocumentPath(output, skillDir), [output, skillDir]);
  const openSkillDoc = useCallback(() => {
    if (docPath) openPreview(docPath);
  }, [openPreview, docPath]);

  const isCompleted = status === 'completed';
  const failure = useMemo(
    () => (isCompleted ? parseJsonFailure(output) : null),
    [isCompleted, output],
  );

  return (
    <BasicTool
      icon={<FileDashedIcon />}
      trigger={
        <span className="text-foreground gap-1 text-sm font-medium">Skill &bull; {skillName}</span>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      onClick={docPath ? openSkillDoc : undefined}
      badge={isCompleted && skillFiles.length > 0 ? `${skillFiles.length} files` : undefined}
    >
      {failure ? (
        <ToolOutputFallback output={output} toolName="skill" />
      ) : isCompleted && (markdownContent || skillFiles.length > 0) ? (
        <div
          data-scrollable
          className={cn('relative max-h-96 overflow-auto px-1', MD_FLUSH_CLASSES)}
        >
          {markdownContent && <UnifiedMarkdown content={markdownContent} isStreaming={false} />}
          {skillFiles.length > 0 && (
            <>
              <Separator className="my-4" />
              <div className="flex flex-col space-y-2">
                <div className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
                  Files
                </div>
                <ul className="space-y-0.5">
                  {skillFiles.map((f, i) => (
                    <li
                      key={i}
                      className="text-muted-foreground flex items-center gap-1.5 font-mono text-xs"
                    >
                      <FileText className="text-muted-foreground size-3 shrink-0" />
                      <span className="truncate">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('skill', SkillTool);
