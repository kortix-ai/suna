import React from 'react';
import {
  GraduationCap,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Building2,
  Globe,
  Star,
  FileText,
  Quote,
  Award
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadingState } from '../shared/LoadingState';
import { extractAuthorSearchData } from './_utils';

export function AuthorSearchToolView({
  name = 'search-authors',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const {
    query,
    total_results,
    results,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractAuthorSearchData(
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
              <GraduationCap className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Search completed' : 'Search failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && results.length === 0 ? (
          <LoadingState
            icon={GraduationCap}
            iconColor="text-blue-500"
            bgColor="bg-blue-500/10"
            title="Searching for authors"
            filePath={query}
            showProgress={true}
          />
        ) : results.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">Authors</h3>
                    <Badge variant="secondary" className="text-xs">
                      {total_results} found
                    </Badge>
                  </div>
                </div>

                <div className="space-y-3">
                  {results.map((author, idx) => (
                    <Card key={author.author_id || idx} className="p-4 hover:bg-muted/50 transition-colors">
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <h4 className="text-base font-semibold">
                                {author.name}
                              </h4>
                              <Badge variant="outline" className="text-xs">
                                #{idx + 1}
                              </Badge>
                            </div>
                            
                            {author.affiliations && author.affiliations.length > 0 && (
                              <div className="flex items-center gap-2 mb-2">
                                <Building2 className="h-3 w-3 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">
                                  {author.affiliations.join(', ')}
                                </p>
                              </div>
                            )}

                            <div className="flex flex-wrap items-center gap-4 text-sm">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center gap-1 cursor-pointer">
                                    <FileText className="h-4 w-4 text-muted-foreground" />
                                    <span className="font-medium">{author.paper_count}</span>
                                    <span className="text-muted-foreground">papers</span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>Total papers published</TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center gap-1 cursor-pointer">
                                    <Quote className="h-4 w-4 text-muted-foreground" />
                                    <span className="font-medium">{author.citation_count}</span>
                                    <span className="text-muted-foreground">citations</span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>Total citations received</TooltipContent>
                              </Tooltip>

                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <div className="flex items-center gap-1 cursor-pointer">
                                    <Award className="h-4 w-4 text-yellow-500" />
                                    <span className="font-medium">{author.h_index}</span>
                                    <span className="text-muted-foreground">h-index</span>
                                  </div>
                                </TooltipTrigger>
                                <TooltipContent>
                                  h-index: measure of productivity and citation impact
                                </TooltipContent>
                              </Tooltip>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {author.homepage && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                    asChild
                                  >
                                    <a
                                      href={author.homepage}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      title="Author homepage"
                                    >
                                      <Globe className="h-3 w-3" />
                                    </a>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Visit homepage</TooltipContent>
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
                                    href={author.url}
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
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <GraduationCap className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No Authors Found
            </h3>
            <div className="bg-muted/50 border rounded-lg p-3 w-full max-w-md text-center mb-4">
              <p className="text-sm text-muted-foreground mb-1">Search query:</p>
              <code className="text-sm font-mono break-all">
                {query || 'No query provided'}
              </code>
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm text-muted-foreground">
                Try searching with different author names
              </p>
              <p className="text-xs text-muted-foreground">
                • Use full names • Try variations • Include middle initials
              </p>
            </div>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          {!isStreaming && results.length > 0 && (
            <>
              <Badge variant="outline" className="text-xs">
                <GraduationCap className="h-3 w-3 mr-1" />
                {results.length} authors
              </Badge>
              {total_results > results.length && (
                <span className="text-xs text-muted-foreground">
                  Showing top {results.length} of {total_results}
                </span>
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

