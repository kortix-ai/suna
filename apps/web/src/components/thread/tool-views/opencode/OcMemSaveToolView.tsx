'use client';

import React, { useMemo } from 'react';
import {
  CheckCircle,
  AlertCircle,
  Brain,
  BookOpen,
  Wrench,
  Tag,
  Save,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';

// ============================================================================
// Types
// ============================================================================

const TYPE_CONFIG: Record<string, { icon: typeof Brain; label: string; color: string }> = {
  episodic: {
    icon: BookOpen,
    label: 'Episodic',
    color: 'bg-foreground/[0.04] text-foreground/85 border-border/50',
  },
  semantic: {
    icon: Brain,
    label: 'Semantic',
    color: 'bg-foreground/[0.04] text-foreground/85 border-border/50',
  },
  procedural: {
    icon: Wrench,
    label: 'Procedural',
    color: 'bg-foreground/[0.04] text-foreground/85 border-border/50',
  },
};

function parseSaveOutput(output: string): { id: string | null; type: string; preview: string } {
  // "Saved to long-term memory [semantic] #42: "the content...""
  const m = output.match(/\[(\w+)\]\s*#(\d+):\s*"(.+)"$/);  // removed /s flag for ES target compat
  return {
    id: m?.[2] ?? null,
    type: m?.[1] ?? 'semantic',
    preview: m?.[3] ?? output,
  };
}

// ============================================================================
// Component
// ============================================================================

export function OcMemSaveToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = (args as any)._oc_state as any;
  const text = (args.text as string) || (ocState?.input?.text as string) || '';
  const memType = (args.type as string) || 'semantic';
  const tags = (args.tags as string) || '';
  const rawOutput = toolResult?.output || ocState?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : String(rawOutput);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const parsed = useMemo(() => parseSaveOutput(output), [output]);
  const config = TYPE_CONFIG[memType] || TYPE_CONFIG.semantic;
  const TypeIcon = config.icon;
  const tagList = tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : [];

  if (isStreaming && !toolResult) {
    return <LoadingState title="Saving memory" subtitle={memType} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Save} title="Save Memory" subtitle={config.label} />
          <Badge
            variant="outline"
            className={cn('h-5 py-0 text-[10px] font-normal flex-shrink-0 ml-2', config.color)}
          >
            <TypeIcon className="h-3 w-3 mr-1" />
            {config.label}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-4 space-y-4">
            {/* Memory content */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
              <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
                {text || parsed.preview}
              </p>
            </div>

            {/* Tags */}
            {tagList.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <Tag className="size-3.5 text-muted-foreground/50 flex-shrink-0" />
                {tagList.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="h-5 py-0 text-[10px] font-normal bg-muted/30"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {/* Saved ID */}
            {parsed.id && !isError && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground/60">
                <CheckCircle className="size-3.5 text-emerald-500" />
                <span>Stored as memory <span className="font-mono">#{parsed.id}</span></span>
              </div>
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
              <CheckCircle className="h-3 w-3 text-emerald-500" />
              Saved
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
