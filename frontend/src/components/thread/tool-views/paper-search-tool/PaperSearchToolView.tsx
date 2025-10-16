import React from 'react';
import {
  BookOpen,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  GraduationCap,
  ScrollText,
  Award,
  Calendar,
  Users,
  Tag,
  BookOpenCheck,
  Copy,
  Star
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { truncateString } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import { LoadingState } from '../shared/LoadingState';
import { extractPaperSearchData } from './_utils';
import { cn } from '@/lib/utils';

export function PaperSearchToolView({
  name = 'paper-search',
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
  } = extractPaperSearchData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const parseEvaluations = (evaluationsText: string) => {
    if (!evaluationsText) return [];
    return evaluationsText.split(' | ').map(item => {
      const [criterion, satisfied] = item.split(': ');
      return { criterion, satisfied };
    });
  };

  const getSourceIcon = (url: string) => {
    const domain = url ? url.toLowerCase() : '';
    
    if (domain.includes('semanticscholar')) return <GraduationCap className="w-4 h-4" />;
    if (domain.includes('arxiv')) return <ScrollText className="w-4 h-4" />;
    if (domain.includes('pubmed') || domain.includes('ncbi')) return <GraduationCap className="w-4 h-4" />;
    if (domain.includes('ieee') || domain.includes('acm')) return <Award className="w-4 h-4" />;
    if (domain.includes('nature') || domain.includes('science') || domain.includes('springer')) return <BookOpen className="w-4 h-4" />;
    if (domain.includes('researchgate') || domain.includes('scholar.google')) return <Users className="w-4 h-4" />;
    return <BookOpenCheck className="w-4 h-4" />;
  };

  const getSourceName = (url: string) => {
    if (!url) return 'Academic Source';
    try {
      const domain = url.toLowerCase();
      if (domain.includes('semanticscholar')) return 'Semantic Scholar';
      if (domain.includes('arxiv')) return 'arXiv';
      if (domain.includes('pubmed')) return 'PubMed';
      if (domain.includes('ncbi')) return 'NCBI';
      if (domain.includes('ieee')) return 'IEEE';
      if (domain.includes('acm')) return 'ACM';
      if (domain.includes('nature')) return 'Nature';
      if (domain.includes('science')) return 'Science';
      if (domain.includes('springer')) return 'Springer';
      if (domain.includes('sciencedirect')) return 'ScienceDirect';
      if (domain.includes('jstor')) return 'JSTOR';
      if (domain.includes('researchgate')) return 'ResearchGate';
      if (domain.includes('scholar.google')) return 'Google Scholar';
      
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.replace(/^www\./, '');
      return hostname.split('.')[0].charAt(0).toUpperCase() + hostname.split('.')[0].slice(1);
    } catch {
      return 'Academic Source';
    }
  };

  const copyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-purple-500/20 border border-purple-500/20">
              <BookOpen className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
            icon={BookOpen}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title="Searching for papers"
            filePath={query}
            showProgress={true}
          />
        ) : results.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">Research Papers</h3>
                    <Badge variant="secondary" className="text-xs">
                      {total_results} found
                    </Badge>
                  </div>
                </div>

                <div className="space-y-3">
                  {results.map((result, idx) => {
                    const evaluations = parseEvaluations(result.evaluations);
                    const satisfiedCount = evaluations.filter(e => e.satisfied?.includes('Satisfied.yes')).length;
                    const sourceName = getSourceName(result.url);

                    return (
                      <Card key={result.id || idx} className="p-4 hover:bg-muted/50 transition-colors">
                        <div className="space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <div className="flex-shrink-0">
                                <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center">
                                  {getSourceIcon(result.url)}
                                </div>
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <Badge variant="outline" className="text-xs">
                                    {sourceName}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {evaluations.length > 0 && satisfiedCount > 0 && (
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <Badge variant="secondary" className="text-xs">
                                          <Star className="w-3 h-3 mr-1" />
                                          {satisfiedCount}/{evaluations.length} match
                                        </Badge>
                                      </TooltipTrigger>
                                      <TooltipContent className="max-w-xs">
                                        <div className="space-y-1">
                                          <p className="font-medium text-xs">Search criteria:</p>
                                          {evaluations.map((evaluation, evalIdx) => (
                                            <div key={evalIdx} className="text-xs flex items-center gap-2">
                                              <div className={cn(
                                                "w-1.5 h-1.5 rounded-full flex-shrink-0",
                                                evaluation.satisfied?.includes('Satisfied.yes')
                                                  ? "bg-primary"
                                                  : "bg-muted-foreground"
                                              )} />
                                              <span className="truncate">{evaluation.criterion}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-8 p-0"
                                    onClick={() => copyToClipboard(result.url, 'URL')}
                                  >
                                    <Copy className="h-3 w-3" />
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent>Copy URL</TooltipContent>
                              </Tooltip>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                asChild
                              >
                                <a 
                                  href={result.url}
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  title="Open paper"
                                >
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                              </Button>
                            </div>
                          </div>
                          
                          {result.description && (
                            <div>
                              <h4 className="text-sm font-medium leading-relaxed mb-2">
                                {truncateString(result.description, 200)}
                              </h4>
                            </div>
                          )}

                          {result.paper_details && (
                            <>
                              <Separator />
                              <div className="bg-muted/50 rounded-md p-3">
                                <div className="flex items-start gap-2">
                                  <BookOpenCheck className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium text-muted-foreground mb-1">Abstract & Details</p>
                                    <p className="text-xs text-muted-foreground leading-relaxed">
                                      {truncateString(result.paper_details, 300)}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-muted/20">
            <div className="w-16 h-16 rounded-lg bg-muted flex items-center justify-center mb-4">
              <BookOpen className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold mb-2">
              No Papers Found
            </h3>
            <div className="bg-muted/50 border rounded-lg p-3 w-full max-w-md text-center mb-4">
              <p className="text-sm text-muted-foreground mb-1">Search query:</p>
              <code className="text-sm font-mono break-all">
                {query || 'No query provided'}
              </code>
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm text-muted-foreground">
                Try searching with different academic terms
              </p>
              <p className="text-xs text-muted-foreground">
                • Use specific keywords • Include author names • Try conference/journal names
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
                <BookOpen className="h-3 w-3 mr-1" />
                {results.length} papers
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
