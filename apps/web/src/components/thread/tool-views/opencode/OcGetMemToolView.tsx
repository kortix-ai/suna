'use client';

import React, { useMemo } from 'react';
import {
  Brain,
  AlertCircle,
  CheckCircle,
  Fingerprint,
  CalendarClock,
  ClipboardList,
  FileText,
  Tags,
  Target,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { parseMemoryEntryOutput } from '@/lib/utils/memory-entry-output';
import { cn } from '@/lib/utils';
import { STATUS_TEXT } from '@/components/ui/status';

export function OcGetMemToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const source = (args.source as string) || '';
  const memoryId = args.id != null ? String(args.id) : '';
  const rawOutput = toolResult?.output || (args as any)._oc_state?.output || '';
  const output = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2);
  const isError = toolResult?.success === false || !!toolResult?.error;

  const report = useMemo(() => parseMemoryEntryOutput(output), [output]);

  if (isStreaming && !toolResult) {
    return <LoadingState title="Get Memory" subtitle={memoryId ? `#${memoryId}` : source || undefined} />;
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle icon={Brain} title="Get Memory" subtitle={memoryId ? `#${memoryId}` : undefined} />
          {(source || memoryId) && (
            <div className="flex items-center gap-1.5 ml-2">
              {source && (
                <Badge variant="outline" className="h-5 py-0 text-[10px]">
                  {source}
                </Badge>
              )}
              {memoryId && (
                <Badge variant="outline" className="h-5 py-0 text-[10px] font-mono">
                  #{memoryId}
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-2">
            {(source || memoryId) && (
              <div className="rounded-2xl border border-border/70 bg-muted/30 p-3">
                <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground mb-2">Request</p>
                <div className="flex flex-wrap items-center gap-2">
                  {source && (
                    <Badge variant="info" className="h-6 text-[11px] font-medium">
                      <Target className="h-3.5 w-3.5" />
                      Source: {source}
                    </Badge>
                  )}
                  {memoryId && (
                    <Badge variant="secondary" className="h-6 text-[11px] font-semibold font-mono">
                      <Fingerprint className="h-3.5 w-3.5" />
                      ID: {memoryId}
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {report ? (
              report.kind === 'observation' ? (
              <div className="rounded-2xl border border-border/70 overflow-hidden bg-background">
                <div className="px-4 py-3 border-b border-border/60 bg-foreground/[0.02]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="h-6 bg-background border-border/60">
                      <Fingerprint className="h-3.5 w-3.5" />
                      Observation #{report.id}
                    </Badge>
                    <Badge variant="outline" className="h-6 bg-foreground/[0.04] text-foreground/85 border-border/50 uppercase tracking-wide text-[10px]">
                      {report.type}
                    </Badge>
                    {report.created && (
                      <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground bg-background/70 border border-border/60 rounded-full px-2 py-1">
                        <CalendarClock className="h-3.5 w-3.5" />
                        {report.created}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-3 text-[1.05rem] font-semibold leading-snug text-foreground">{report.title}</h3>
                </div>

                <div className="px-4 py-3 space-y-3">
                  {report.narrative && (
                    <div className="rounded-2xl border border-border/60 bg-foreground/[0.02] p-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
                        <FileText className="h-3.5 w-3.5" />
                        Narrative
                      </span>
                      <p className="text-sm leading-relaxed text-foreground/85">{report.narrative}</p>
                    </div>
                  )}

                  {report.facts.length > 0 && (
                    <div className="rounded-2xl border border-border/60 bg-foreground/[0.02] p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                          <ClipboardList className="h-3.5 w-3.5" />
                          Facts
                        </span>
                        <Badge variant="secondary" className="h-5 text-[10px] font-medium">{report.facts.length}</Badge>
                      </div>
                      <ul className="space-y-1.5">
                        {report.facts.map((fact, idx) => (
                          <li key={`${report.id}-${idx}`} className="flex items-start gap-2 text-sm text-foreground/90 leading-relaxed">
                            <span className="mt-[8px] h-1.5 w-1.5 rounded-full bg-foreground/60 flex-shrink-0" />
                            <span>{fact}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {report.concepts.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 rounded-2xl border border-border/60 bg-foreground/[0.02] p-2.5">
                      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground mr-1">
                        <Tags className="h-3.5 w-3.5" />
                        Concepts
                      </span>
                      {report.concepts.map((concept) => (
                        <Badge key={concept} variant="secondary" className="h-6 px-2 text-[11px] font-medium bg-foreground/[0.04] text-foreground/85 border-border/50">
                          <Tags className="h-3 w-3" />
                          {concept}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {(report.tool || report.prompt || report.session || report.filesRead.length > 0) && (
                    <div className="rounded-2xl border border-border/60 bg-foreground/[0.02] p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        {report.tool && <Badge variant="outline" className="h-5 px-1.5 font-medium bg-background/80">Tool: {report.tool}</Badge>}
                        {report.prompt && <Badge variant="outline" className="h-5 px-1.5 font-medium bg-background/80">Prompt #{report.prompt}</Badge>}
                        {report.session && <Badge variant="outline" className="h-5 px-1.5 font-medium font-mono bg-background/80">{report.session}</Badge>}
                      </div>
                      {report.filesRead.length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">Files read</p>
                          <div className="flex flex-wrap gap-1.5">
                            {report.filesRead.map((file) => (
                              <span
                                key={file}
                                className="px-2 py-1 rounded-md bg-background border border-border/70 text-[11px] font-mono text-foreground/75 break-all"
                              >
                                {file}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              ) : (
              <div className="rounded-2xl border border-border/70 overflow-hidden bg-background">
                <div className="px-4 py-3 border-b border-border/60 bg-foreground/[0.02]">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="h-6 bg-background border-border/60">
                      <Fingerprint className="h-3.5 w-3.5" />
                      LTM #{report.id}
                    </Badge>
                    <Badge variant="outline" className="h-6 bg-foreground/[0.04] text-foreground/85 border-border/50 uppercase tracking-wide text-[10px]">
                      {report.type}
                    </Badge>
                    {report.created && (
                      <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted-foreground bg-background/70 border border-border/60 rounded-full px-2 py-1">
                        <CalendarClock className="h-3.5 w-3.5" />
                        {report.created}
                      </span>
                    )}
                  </div>
                </div>

                <div className="px-4 py-3 space-y-3">
                  {report.caption && (
                    <div className="rounded-2xl border border-border/60 bg-foreground/[0.02] p-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
                        <FileText className="h-3.5 w-3.5" />
                        Caption
                      </span>
                      <p className="text-sm leading-relaxed text-foreground/85">{report.caption}</p>
                    </div>
                  )}

                  {report.content && (
                    <div className="rounded-2xl border border-border/60 bg-foreground/[0.02] p-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground mb-1.5">
                        <ClipboardList className="h-3.5 w-3.5" />
                        Content
                      </span>
                      <p className="text-sm leading-relaxed text-foreground/90">{report.content}</p>
                    </div>
                  )}

                  {report.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 rounded-2xl border border-border/60 bg-foreground/[0.02] p-2.5">
                      <span className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.16em] text-muted-foreground mr-1">
                        <Tags className="h-3.5 w-3.5" />
                        Tags
                      </span>
                      {report.tags.map((tag) => (
                        <Badge key={tag} variant="secondary" className="h-6 px-2 text-[11px] font-medium bg-foreground/[0.04] text-foreground/85 border-border/50">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {(report.session || report.updated) && (
                    <div className="rounded-2xl border border-border/60 bg-foreground/[0.02] p-3 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        {report.session && <Badge variant="outline" className="h-5 px-1.5 font-medium font-mono bg-background/80">{report.session}</Badge>}
                        {report.updated && <Badge variant="outline" className="h-5 px-1.5 font-medium bg-background/80">Updated: {report.updated}</Badge>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
              )
            ) : isError ? (
              <div className="flex items-start gap-2.5 px-4 py-6 text-muted-foreground">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p className="text-sm">{output || 'Get memory failed'}</p>
              </div>
            ) : (
              <div className="rounded-2xl border border-border/60 bg-muted/10 p-3">
                <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-mono">{output}</pre>
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
              <CheckCircle className={cn('h-3 w-3', STATUS_TEXT.success)} />
              Completed
            </Badge>
          )
        )}
      </ToolViewFooter>
    </Card>
  );
}
