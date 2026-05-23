'use client';

import React, { useMemo, useState } from 'react';
import { BookOpen, CheckCircle, AlertCircle, ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/ui/status';

/** Extract content from <skill_content> XML wrapper */
function extractSkillContent(output: string): string {
  const match = output.match(/<skill_content[^>]*>([\s\S]*)<\/skill_content>/);
  return match ? match[1].trim() : output;
}

/** Extract <skill_files> entries */
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

export function OcSkillToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;
  const metadata = ocState?.metadata || {};

  const skillName = (metadata.name || args.name || '') as string;
  const skillDir = (metadata.dir || '') as string;
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = String(rawOutput);

  const content = useMemo(() => extractSkillContent(output), [output]);
  const files = useMemo(() => extractSkillFiles(output), [output]);

  // Strip the skill_files block from content for cleaner markdown rendering
  const markdownContent = useMemo(() => {
    return content
      .replace(/<skill_files>[\s\S]*?<\/skill_files>/, '')
      .replace(/Base directory:.*$/m, '')
      .replace(/Note:.*relative to the base directory.*$/m, '')
      .trim();
  }, [content]);

  const isError = toolResult?.success === false || !!toolResult?.error;

  if (isStreaming && !toolResult) {
    return <LoadingState title="Loading Skill" subtitle={skillName} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={BookOpen}
            title={skillName || 'Skill'}
            subtitle={skillDir || undefined}
          />
          <span className="inline-flex items-center text-xs text-muted-foreground/80 tracking-tight flex-shrink-0 font-mono">
            SKILL.md
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-4">
            {markdownContent ? (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <UnifiedMarkdown content={markdownContent} />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No skill content available.</div>
            )}

            {files.length > 0 && (
              <SkillFiles files={files} />
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && (
          isError ? (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted text-muted-foreground">
              <AlertCircle className="h-3 w-3" />
              Failed
            </Badge>
          ) : (
            <Badge variant="outline" className="h-6 py-0.5 bg-muted">
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              Loaded
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}

function SkillFiles({ files }: { files: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-border/50 rounded-2xl overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        <FolderOpen className="size-3.5 text-muted-foreground shrink-0" />
        <span className="text-xs font-medium">{files.length} skill file{files.length !== 1 ? 's' : ''}</span>
      </button>
      {open && (
        <div className="border-t border-border/30 px-3 py-2 space-y-1">
          {files.map((f, i) => (
            <div key={i} className="text-xs font-mono text-muted-foreground truncate">{f}</div>
          ))}
        </div>
      )}
    </div>
  );
}
