import React, { useState } from 'react';
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
  Award,
  ChevronDown,
  ChevronUp,
  Link2
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { LoadingState } from '../shared/LoadingState';
import { extractAuthorDetailsData } from './_utils';

export function AuthorDetailsToolView({
  name = 'get-author-details',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  const [showAllPapers, setShowAllPapers] = useState(false);

  const {
    author,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractAuthorDetailsData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const renderPaper = (paper: any, index: number) => (
    <Card key={index} className="p-3 hover:bg-muted/50 transition-colors">
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium leading-relaxed line-clamp-2">
              {paper.title}
            </h4>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 flex-shrink-0"
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
        </div>
        
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {paper.year && (
            <Badge variant="outline" className="text-xs">
              {paper.year}
            </Badge>
          )}
          {paper.citation_count > 0 && (
            <div className="flex items-center gap-1">
              <Quote className="h-3 w-3" />
              <span>{paper.citation_count} citations</span>
            </div>
          )}
          {paper.venue && (
            <span className="truncate">{paper.venue}</span>
          )}
        </div>
        
        {paper.abstract && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {paper.abstract}
          </p>
        )}
      </div>
    </Card>
  );

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
              {actualIsSuccess ? 'Details loaded' : 'Failed to load'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && !author ? (
          <LoadingState
            icon={GraduationCap}
            iconColor="text-blue-500"
            bgColor="bg-blue-500/10"
            title="Loading author details"
            showProgress={true}
          />
        ) : author ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4 space-y-6">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <h2 className="text-xl font-semibold leading-relaxed">
                      {author.name}
                    </h2>
                    
                    {author.affiliations && author.affiliations.length > 0 && (
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">
                          {author.affiliations.join(', ')}
                        </p>
                      </div>
                    )}
                  </div>

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

                  <div className="flex items-center gap-2">
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-2"
                      asChild
                    >
                      <a href={author.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" />
                        View on Semantic Scholar
                      </a>
                    </Button>
                    
                    {author.homepage && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-2"
                        asChild
                      >
                        <a href={author.homepage} target="_blank" rel="noopener noreferrer">
                          <Globe className="h-4 w-4" />
                          Homepage
                        </a>
                      </Button>
                    )}
                  </div>
                </div>

                {author.external_ids && Object.keys(author.external_ids).length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4 text-muted-foreground" />
                        <h3 className="text-sm font-medium">External IDs</h3>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(author.external_ids).map(([key, value]) => (
                          <Badge key={key} variant="outline" className="font-mono text-xs">
                            {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {author.papers && author.papers.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <h3 className="text-sm font-medium">
                            Papers ({author.papers.length})
                          </h3>
                        </div>
                        {author.papers.length > 5 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowAllPapers(!showAllPapers)}
                            className="gap-1"
                          >
                            {showAllPapers ? (
                              <>
                                <ChevronUp className="h-4 w-4" />
                                Show less
                              </>
                            ) : (
                              <>
                                <ChevronDown className="h-4 w-4" />
                                Show all
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                      <div className="space-y-2">
                        {(showAllPapers ? author.papers : author.papers.slice(0, 5)).map(renderPaper)}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <GraduationCap className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No Author Details Found
            </h3>
            <p className="text-sm text-muted-foreground text-center">
              Unable to load author details. Please try again.
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 bg-muted/30 backdrop-blur-sm border-t flex justify-between items-center gap-4">
        <div className="flex items-center gap-2">
          {!isStreaming && author && (
            <>
              <Badge variant="outline" className="text-xs">
                <GraduationCap className="h-3 w-3 mr-1" />
                Author ID: {author.author_id}
              </Badge>
              {author.papers && (
                <Badge variant="outline" className="text-xs">
                  {author.papers.length} papers shown
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

