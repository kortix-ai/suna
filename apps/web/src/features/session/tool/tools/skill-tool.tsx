'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  BasicTool,
  MD_FLUSH_CLASSES,
  partInput,
  partOutput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import {
  extractSkillContent,
  extractSkillFiles,
} from '@/features/session/tool/shared/skill-helpers';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { BookOpen, ExternalLink, FileText } from 'lucide-react';
import { useMemo, useState } from 'react';

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

  const [sheetOpen, setSheetOpen] = useState(false);

  const isCompleted = status === 'completed';

  const sheetBodyContent = useMemo(() => {
    if (skillFiles.length === 0) return markdownContent;
    return `${markdownContent}\n\n---\n\n**Files**\n${skillFiles.map((f) => `- \`${f}\``).join('\n')}`;
  }, [markdownContent, skillFiles]);

  return (
    <>
      <BasicTool
        icon={<BookOpen />}
        trigger={
          <span className="text-foreground text-sm font-medium">Skill &bull; {skillName}</span>
        }
        defaultOpen={defaultOpen}
        forceOpen={forceOpen}
        locked={locked}
        onClick={() => setSheetOpen(true)}
        badge={isCompleted && skillFiles.length > 0 ? `${skillFiles.length} files` : undefined}
        rightAccessory={<ExternalLink />}
      >
        {isCompleted && (markdownContent || skillFiles.length > 0) ? (
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

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="border-border shrink-0 space-y-1 border-b p-5 pr-12">
            <SheetTitle className="text-base font-semibold">{skillName}</SheetTitle>
            {skillDir ? (
              <SheetDescription className="truncate font-mono text-xs">{skillDir}</SheetDescription>
            ) : null}
          </SheetHeader>
          <SheetBody className={cn('min-h-0 px-5 py-4', MD_FLUSH_CLASSES)}>
            <UnifiedMarkdown content={sheetBodyContent} isStreaming={false} />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
ToolRegistry.register('skill', SkillTool);
