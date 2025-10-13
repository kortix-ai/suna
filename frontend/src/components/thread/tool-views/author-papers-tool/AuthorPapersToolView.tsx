import React from 'react';
import {
  GraduationCap,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  FileText,
  Quote,
  Award,
  Calendar,
  ArrowRight,
  BookOpenCheck
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
import { extractAuthorPapersData } from './_utils';

export function AuthorPapersToolView({
  name = 'get-author-papers',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    author_id,
    papers_returned,
    has_more,
    papers,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractAuthorPapersData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-blue-500/20 border border-blue-500/20">
              <FileText className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Papers loaded' : 'Failed to load'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && papers.length === 0 ? (
          <LoadingState
            icon={FileText}
            iconColor="text-blue-500"
            bgColor="bg-blue-500/10"
            title="Loading author papers"
            filePath={author_id}
            showProgress={true}
          />
        ) : papers.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">Author Publications</h3>
                    <Badge variant="secondary" className="text-xs">
                      {papers_returned} papers
                    </Badge>
                    {has_more && (
                      <Badge variant="outline" className="text-xs text-orange-600">
                        More available
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                  {papers.map((paper, idx) => (
                    <Card key={paper.paper_id || idx} className="p-4 hover:bg-muted/50 transition-colors">
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge variant="outline" className="text-xs">
                                #{paper.rank}
                              </Badge>
                              {paper.year && (
                                <Badge variant="outline" className="text-xs gap-1">
                                  <Calendar className="h-3 w-3" />
                                  {paper.year}
                                </Badge>
                              )}
                              {paper.is_open_access && (
                                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 text-xs">
                                  Open Access
                                </Badge>
                              )}
                            </div>
                            
                            <h4 className="text-sm font-medium leading-relaxed mb-2">
                              {paper.title}
                            </h4>

                            {paper.venue && (
                              <div className="flex items-center gap-2 mb-2">
                                <Award className="h-3 w-3 text-muted-foreground" />
                                <p className="text-xs text-muted-foreground">
                                  {paper.venue}
                                </p>
                              </div>
                            )}

                            <div className="flex flex-wrap items-center gap-4 text-xs">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center gap-1 cursor-pointer">
                                    <Quote className="h-3 w-3 text-muted-foreground" />
                                    <span className="font-medium">{paper.citation_count}</span>
                                    <span className="text-muted-foreground">citations</span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>Total citations</TooltipContent>
                              </Tooltip>

                              {paper.influential_citation_count > 0 && (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <div className="flex items-center gap-1 cursor-pointer">
                                      <Award className="h-3 w-3 text-yellow-500" />
                                      <span className="font-medium">{paper.influential_citation_count}</span>
                                      <span className="text-muted-foreground">influential</span>
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent>Highly influential citations</TooltipContent>
                                </Tooltip>
                              )}

                              {paper.fields_of_study && paper.fields_of_study.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {paper.fields_of_study.slice(0, 2).map((field, i) => (
                                    <Badge key={i} variant="outline" className="text-xs">
                                      {field}
                                    </Badge>
                                  ))}
                                  {paper.fields_of_study.length > 2 && (
                                    <Badge variant="outline" className="text-xs">
                                      +{paper.fields_of_study.length - 2}
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {paper.pdf_url && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                    asChild
                                  >
                                    <a
                                      href={paper.pdf_url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="Open PDF"
                                    >
                                      <FileText className="h-3 w-3" />
                                    </a>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Open PDF</TooltipContent>
                              </Tooltip>
                            )}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0"
                                  asChild
                                >
                                  <a
                                    href={paper.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title="View on Semantic Scholar"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>View on Semantic Scholar</TooltipContent>
                            </Tooltip>
                          </div>
                        </div>

                        {paper.abstract && (
                          <div className="bg-muted/50 rounded-md p-3">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {truncateString(paper.abstract, 200)}
                            </p>
                          </div>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>

                {has_more && (
                  <div className="flex items-center justify-center gap-2 p-4 bg-muted/30 rounded-lg">
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      More papers available - use offset parameter to load more
                    </p>
                  </div>
                )}
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No Papers Found
            </h3>
            <p className="text-sm text-muted-foreground text-center">
              No papers found for this author.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          {!isStreaming && papers.length > 0 && (
            <>
              <Badge variant="outline" className="text-xs">
                <FileText className="h-3 w-3 mr-1" />
                {papers.length} papers
              </Badge>
              {author_id && (
                <Badge variant="outline" className="text-xs font-mono">
                  {author_id}
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

