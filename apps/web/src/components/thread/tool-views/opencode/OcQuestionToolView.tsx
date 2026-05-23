'use client';

import React, { useMemo } from 'react';
import { MessageCircle, CheckCircle, Clock } from 'lucide-react';
import { ToolViewProps } from '../types';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToolViewIconTitle } from '../shared/ToolViewIconTitle';
import { ToolViewFooter } from '../shared/ToolViewFooter';
import { LoadingState } from '../shared/LoadingState';
import { cn } from '@/lib/utils';

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionInfo {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
}

export function OcQuestionToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isStreaming = false,
}: ToolViewProps) {
  const args = toolCall?.arguments || {};
  const ocState = args._oc_state as any;

  const questions = useMemo<QuestionInfo[]>(() => {
    const raw = args.questions || ocState?.input?.questions;
    return Array.isArray(raw) ? raw : [];
  }, [args.questions, ocState?.input?.questions]);

  const answers = useMemo<string[][]>(() => {
    const raw = ocState?.metadata?.answers;
    return Array.isArray(raw) ? raw : [];
  }, [ocState?.metadata?.answers]);

  const isAnswered = answers.length > 0;
  const isRunning = !toolResult && !isAnswered;

  if (isStreaming && !toolResult) {
    return (
      <LoadingState
        title="Questions"
      />
    );
  }

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-11 bg-background border-b border-border/50 px-3 py-0 space-y-0 flex justify-center">
        <div className="flex flex-row items-center justify-between">
          <ToolViewIconTitle
            icon={MessageCircle}
            title={isAnswered ? `Asked ${questions.length} ${questions.length === 1 ? 'Question' : 'Questions'}` : 'Questions'}
          />
          {isAnswered && (
            <Badge variant="outline" className="h-5 text-xs bg-muted">
              <CheckCircle className="h-3 w-3 text-muted-foreground" />
              Answered
            </Badge>
          )}
          {isRunning && (
            <Badge variant="outline" className="h-5 text-xs bg-muted">
              <Clock className="h-3 w-3 text-muted-foreground" />
              Waiting
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden">
        <ScrollArea className="h-full w-full">
          <div className="p-3 space-y-3">
            {questions.map((q, i) => {
              const answer = answers[i] || [];
              const hasAnswer = answer.length > 0;

              return (
                <div key={i} className="space-y-1.5">
                  {q.header && (
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {q.header}
                    </span>
                  )}

                  <p className="text-sm font-medium text-foreground">{q.question}</p>

                  {q.options && q.options.length > 0 && (
                    <div className="space-y-1">
                      {q.options.map((opt, j) => {
                        const isSelected = hasAnswer && answer.includes(opt.label);
                        return (
                          <div
                            key={j}
                            className={cn(
                              'flex items-center gap-2 px-2.5 py-1.5 rounded-2xl transition-colors',
                              isSelected ? 'bg-muted' : 'bg-transparent',
                            )}
                          >
                            <span className={cn(
                              'size-3 rounded-sm flex-shrink-0 flex items-center justify-center border',
                              isSelected ? 'border-foreground/30 bg-foreground/10' : 'border-border',
                            )}>
                              {isSelected && (
                                <svg viewBox="0 0 12 12" fill="none" width="8" height="8"><path d="M3 7.17905L5.02703 8.85135L9 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" className="text-foreground" /></svg>
                              )}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span className={cn('text-xs', isSelected ? 'font-medium text-foreground' : 'text-foreground/80')}>
                                {opt.label}
                              </span>
                              {opt.description && (
                                <p className="text-xs text-muted-foreground">{opt.description}</p>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Custom answer (not from options) */}
                  {hasAnswer && q.options && !q.options.some(o => answer.includes(o.label)) && (
                    <div className="px-2.5 py-1.5 rounded-2xl bg-muted">
                      <span className="text-xs text-muted-foreground">Custom answer</span>
                      <p className="text-xs text-foreground">{answer.join(', ')}</p>
                    </div>
                  )}

                  {/* Answer display when no options */}
                  {hasAnswer && (!q.options || q.options.length === 0) && (
                    <div className="px-2.5 py-1.5 rounded-2xl bg-muted/50">
                      <p className="text-xs text-foreground">{answer.join(', ')}</p>
                    </div>
                  )}

                  {i < questions.length - 1 && (
                    <div className="h-px bg-border/30 mt-2" />
                  )}
                </div>
              );
            })}

            {questions.length === 0 && (
              <p className="text-xs text-muted-foreground">No questions to display.</p>
            )}
          </div>
        </ScrollArea>
      </CardContent>

      <ToolViewFooter
        assistantTimestamp={assistantTimestamp}
        toolTimestamp={toolTimestamp}
        isStreaming={isStreaming}
      >
        {!isStreaming && isAnswered && (
          <Badge variant="outline" className="h-6 py-0.5 bg-muted">
            <CheckCircle className="h-3 w-3 text-muted-foreground" />
            Completed
          </Badge>
        )}
      </ToolViewFooter>
    </Card>
  );
}
