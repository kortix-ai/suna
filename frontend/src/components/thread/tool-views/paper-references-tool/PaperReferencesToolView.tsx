import React, { useState } from 'react';
import {
  GitBranch,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Calendar,
  Users,
  Award,
  Star,
  MessageSquare,
  Target,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Quote
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingState } from '../shared/LoadingState';
import { extractPaperReferencesData } from './_utils';
import { cn } from '@/lib/utils';

export function PaperReferencesToolView({
  name = 'get-paper-references',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [expandedReferences, setExpandedReferences] = useState<Set<number>>(new Set());

  const {
    paper_id,
    references_returned,
    has_more,
    references,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractPaperReferencesData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const toggleExpanded = (index: number) => {
    const newExpanded = new Set(expandedReferences);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedReferences(newExpanded);
  };

  const getIntentColor = (intent: string) => {
    const intentLower = intent.toLowerCase();
    if (intentLower.includes('methodology')) return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
    if (intentLower.includes('background')) return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
    if (intentLower.includes('result')) return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
    return 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300';
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-indigo-500/20 border border-indigo-500/20">
              <GitBranch className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={
                actualIsSuccess
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                  : "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
              }
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {actualIsSuccess ? 'References loaded' : 'Failed to load'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && references.length === 0 ? (
          <LoadingState
            icon={GitBranch}
            iconColor="text-indigo-500"
            bgColor="bg-indigo-500/10"
            title="Loading references"
            filePath={paper_id}
            showProgress={true}
          />
        ) : references.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">Papers Referenced by This Work</h3>
                    <Badge variant="secondary" className="text-xs">
                      {references_returned} references
                    </Badge>
                    {has_more && (
                      <Badge variant="outline" className="text-xs text-orange-600">
                        More available
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  {references.map((reference, idx) => {
                    const isExpanded = expandedReferences.has(idx);
                    const hasContexts = reference.contexts && reference.contexts.length > 0;
                    
                    return (
                      <Card key={idx} className="p-4 hover:bg-muted/50 transition-colors">
                        <div className="space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-2">
                                <Badge variant="outline" className="text-xs">
                                  #{reference.rank}
                                </Badge>
                                {reference.cited_paper.year && (
                                  <Badge variant="outline" className="text-xs gap-1">
                                    <Calendar className="h-3 w-3" />
                                    {reference.cited_paper.year}
                                  </Badge>
                                )}
                                {reference.is_influential && (
                                  <Badge className="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300 text-xs gap-1">
                                    <Star className="h-3 w-3" />
                                    Influential
                                  </Badge>
                                )}
                              </div>
                              
                              <h4 className="text-sm font-medium leading-relaxed mb-2">
                                {reference.cited_paper.title}
                              </h4>

                              {reference.cited_paper.authors && reference.cited_paper.authors.length > 0 && (
                                <div className="flex items-center gap-2 mb-2">
                                  <Users className="h-3 w-3 text-muted-foreground" />
                                  <p className="text-xs text-muted-foreground line-clamp-1">
                                    {reference.cited_paper.authors.slice(0, 3).join(', ')}
                                    {reference.cited_paper.authors.length > 3 && ` +${reference.cited_paper.authors.length - 3} more`}
                                  </p>
                                </div>
                              )}

                              {reference.cited_paper.venue && (
                                <div className="flex items-center gap-2 mb-2">
                                  <Award className="h-3 w-3 text-muted-foreground" />
                                  <p className="text-xs text-muted-foreground">
                                    {reference.cited_paper.venue}
                                  </p>
                                </div>
                              )}

                              <div className="flex flex-wrap items-center gap-2">
                                {reference.cited_paper.citation_count > 0 && (
                                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Quote className="h-3 w-3" />
                                    <span>{reference.cited_paper.citation_count} citations</span>
                                  </div>
                                )}
                                
                                {reference.intents && reference.intents.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {reference.intents.map((intent, i) => (
                                      <Badge key={i} className={cn("text-xs", getIntentColor(intent))}>
                                        <Target className="h-3 w-3 mr-1" />
                                        {intent}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                            
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 flex-shrink-0"
                              asChild
                            >
                              <a
                                href={reference.cited_paper.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="View on Semantic Scholar"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            </Button>
                          </div>

                          {hasContexts && (
                            <div className="space-y-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => toggleExpanded(idx)}
                                className="gap-1 h-7 text-xs"
                              >
                                <MessageSquare className="h-3 w-3" />
                                {reference.contexts.length} citation context{reference.contexts.length > 1 ? 's' : ''}
                                {isExpanded ? (
                                  <ChevronUp className="h-3 w-3" />
                                ) : (
                                  <ChevronDown className="h-3 w-3" />
                                )}
                              </Button>

                              {isExpanded && (
                                <div className="space-y-2 pl-2 border-l-2 border-indigo-200 dark:border-indigo-800">
                                  {reference.contexts.map((context, i) => (
                                    <div key={i} className="bg-indigo-50 dark:bg-indigo-950/30 rounded-md p-3">
                                      <p className="text-xs text-indigo-900 dark:text-indigo-100 leading-relaxed italic">
                                        "{truncateString(context, 300)}"
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>

                {has_more && (
                  <div className="flex items-center justify-center gap-2 p-4 bg-muted/30 rounded-lg mt-4">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      More references available - use offset parameter to load more
                    </p>
                  </div>
                )}
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <GitBranch className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No References Found
            </h3>
            <p className="text-sm text-muted-foreground text-center">
              No papers found that this work references.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          {!isStreaming && references.length > 0 && (
            <>
              <Badge variant="outline" className="text-xs">
                <GitBranch className="h-3 w-3 mr-1" />
                {references.length} references
              </Badge>
              {paper_id && (
                <Badge variant="outline" className="text-xs font-mono">
                  {paper_id.slice(0, 8)}...
                </Badge>
              )}
            </>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
}

