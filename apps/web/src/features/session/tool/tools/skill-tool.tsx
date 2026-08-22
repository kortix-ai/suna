'use client';

import {
  BasicTool,
  parseJsonFailure,
  partInput,
  partOutput,
  partStatus,
  ToolMarkdownCard,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import {
  extractSkillContent,
  extractSkillFiles,
  skillDocumentPath,
  skillInputDir,
} from '@/features/session/tool/shared/skill-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { useFilePreviewStore } from '@/stores/file-preview-store';
import { FileDashedIcon } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';

/**
 * A skill call is the same disclosure as Read / Edit: verb, target, flush card.
 *
 * Title is the tool ("Skill"). Subtitle is the skill name, and clicking it
 * opens `SKILL.md` in the session preview — the same affordance a filename
 * has on a read row. The document itself sits in {@link ToolMarkdownCard};
 * listed files sit in {@link ToolResultCard}, matching a directory read.
 */
export function SkillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const output = partOutput(part);

  const rawName = typeof input.name === 'string' ? input.name.trim() : '';
  // `skillDocumentPath` refuses the 'skill' placeholder as a directory name, so
  // the fallback is safe to pass through.
  const skillName = rawName || 'skill';
  const skillDir = skillInputDir(input);

  const skillContent = useMemo(() => extractSkillContent(output), [output]);
  const skillFiles = useMemo(() => extractSkillFiles(output), [output]);

  const documentContent = useMemo(() => {
    return skillContent
      .trimStart()
      .replace(/<skill_files>[\s\S]*?<\/skill_files>/, '')
      .replace(/Base directory:.*$/m, '')
      .replace(/Note:.*relative to the base directory.*$/m, '')
      .trim();
  }, [skillContent]);

  const openPreview = useFilePreviewStore((s) => s.openPreview);
  const docPath = useMemo(
    () => skillDocumentPath(output, skillDir, skillName),
    [output, skillDir, skillName],
  );
  const openSkillDoc = useCallback(() => {
    if (docPath) openPreview(docPath);
  }, [openPreview, docPath]);

  const isCompleted = status === 'completed';
  const failure = useMemo(
    () => (isCompleted ? parseJsonFailure(output) : null),
    [isCompleted, output],
  );

  const hasBody = isCompleted && (documentContent || skillFiles.length > 0);

  return (
    <BasicTool
      icon={<FileDashedIcon className="size-3.5 shrink-0" />}
      trigger={{
        title: 'Skill',
        subtitle: rawName || undefined,
      }}
      onSubtitleClick={docPath ? openSkillDoc : undefined}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
      className="overflow-hidden p-0"
    >
      {failure ? (
        <ToolOutputFallback output={output} toolName="skill" />
      ) : hasBody ? (
        <>
          {documentContent ? <ToolMarkdownCard code={documentContent} /> : null}
          {skillFiles.length > 0 ? (
            <ToolResultCard bodyClassName="space-y-0.5 px-2 py-1.5">
              {skillFiles.map((file) => (
                <div
                  key={file}
                  className="text-muted-foreground/80 flex items-center gap-1.5 font-mono text-xs"
                >
                  <FileDashedIcon className="text-muted-foreground/40 size-3 shrink-0" />
                  <span className="truncate">{file}</span>
                </div>
              ))}
            </ToolResultCard>
          ) : null}
        </>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('skill', SkillTool);
