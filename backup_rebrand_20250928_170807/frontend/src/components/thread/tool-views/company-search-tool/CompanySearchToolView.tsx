import React from 'react';
import {
  Building2,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  MapPin,
  Globe,
  Award,
  Info,
  Building
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
import { extractCompanySearchData } from './_utils';
import { cn } from '@/lib/utils';

export function CompanySearchToolView({
  name = 'company-search',
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
    cost_deducted,
    results,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCompanySearchData(
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

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-blue-500/20 border border-blue-500/20">
              <Building2 className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <div className="flex items-center gap-2">
              {cost_deducted && (
                <Badge variant="outline" className="text-xs font-normal text-orange-600 dark:text-orange-400">
                  {cost_deducted}
                </Badge>
              )}
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
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming && results.length === 0 ? (
          <LoadingState
            icon={Building2}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title="Searching for companies"
            filePath={query}
            showProgress={true}
          />
        ) : results.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-4">
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-3 flex items-center justify-between">
                  <span>Found {total_results} companies</span>
                </div>

                <div className="space-y-3">
                  {results.map((result, idx) => {
                    const evaluations = parseEvaluations(result.evaluations);
                    const satisfiedCount = evaluations.filter(e => e.satisfied?.includes('Satisfied.yes')).length;

                    return (
                      <div
                        key={result.id || idx}
                        className="group relative border-b border-border last:border-b-0 pb-3 last:pb-0"
                      >
                        <div className="flex items-start gap-3">
                          <div className="flex-shrink-0 mt-0.5">
                            {result.company_logo_url && result.company_logo_url !== '' ? (
                              <img
                                src={result.company_logo_url}
                                alt={result.company_name}
                                className="w-8 h-8 rounded-lg object-cover"
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement;
                                  target.style.display = 'none';
                                  const fallback = target.nextSibling as HTMLElement;
                                  if (fallback) fallback.style.display = 'flex';
                                }}
                              />
                            ) : null}
                            <div 
                              className="w-8 h-8 rounded bg-muted flex items-center justify-center"
                              style={{ display: result.company_logo_url ? 'none' : 'flex' }}
                            >
                              <Building2 className="w-4 h-4 text-muted-foreground" />
                            </div>
                          </div>

                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <h3 className="font-medium text-sm text-foreground truncate">
                                  {result.company_name || 'Unknown Company'}
                                </h3>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                                  {result.company_industry && (
                                    <span className="truncate">{result.company_industry}</span>
                                  )}
                                  {result.company_industry && result.company_location && (
                                    <span>•</span>
                                  )}
                                  {result.company_location && (
                                    <span className="truncate">{result.company_location}</span>
                                  )}
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {evaluations.length > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <Badge 
                                        variant="outline"
                                        className={cn(
                                          "text-xs h-5 px-1.5",
                                          satisfiedCount > 0 
                                            ? "border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
                                            : "border-muted-foreground/20"
                                        )}
                                      >
                                        {satisfiedCount}/{evaluations.length}
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      <div className="space-y-1">
                                        <p className="font-medium text-xs">Criteria match:</p>
                                        {evaluations.map((evaluation, evalIdx) => (
                                          <div key={evalIdx} className="text-xs flex items-center gap-2">
                                            <div className={cn(
                                              "w-1.5 h-1.5 rounded-full flex-shrink-0",
                                              evaluation.satisfied?.includes('Satisfied.yes')
                                                ? "bg-emerald-400"
                                                : "bg-muted-foreground"
                                            )} />
                                            <span className="truncate">{evaluation.criterion}</span>
                                          </div>
                                        ))}
                                      </div>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                                
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-6 w-6 p-0 opacity-60 hover:opacity-100 transition-opacity"
                                  asChild
                                >
                                  <a 
                                    href={result.url}
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    title="View company details"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                </Button>
                              </div>
                            </div>
                            
                            {result.description && (
                              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                                {truncateString(result.description, 120)}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </TooltipProvider>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-12 px-6 bg-zinc-50/50 dark:bg-zinc-900/50">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6 bg-muted">
              <Building2 className="h-10 w-10 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No Companies Found
            </h3>
            <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center mb-4">
              <code className="text-sm font-mono text-zinc-700 dark:text-zinc-300 break-all">
                {query || 'Unknown query'}
              </code>
            </div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Try refining your search criteria for better results
            </p>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-zinc-50/90 dark:bg-zinc-900/90 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && results.length > 0 && (
            <Badge variant="outline" className="h-6 py-0.5 text-xs">
              <Building2 className="h-3 w-3 mr-1" />
              {results.length} results
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
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
