import React from 'react';
import {
  Users,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  MapPin,
  Briefcase,
  User,
  Globe,
  Award,
  Mail,
  Info
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
import { extractPeopleSearchData } from './_utils';
import { cn } from '@/lib/utils';

export function PeopleSearchToolView({
  name = 'people-search',
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
  } = extractPeopleSearchData(
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

  const parseEnrichmentData = (enrichmentData: string) => {
    if (!enrichmentData) return {};
    const parts = enrichmentData.split(' | ');
    return {
      linkedinUrl: parts[0] || '',
      email: parts[1] !== 'null' ? parts[1] : '',
      position: parts[2] || '',
      company: parts[3] || ''
    };
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-purple-500/20 border border-purple-500/20">
              <Users className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
            icon={Users}
            iconColor="text-primary"
            bgColor="bg-primary/10"
            title="Searching for people"
            filePath={query}
            showProgress={true}
          />
        ) : results.length > 0 ? (
          <ScrollArea className="h-full w-full">
            <TooltipProvider>
              <div className="p-3">
                <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200 mb-3 flex items-center justify-between">
                  <span>Found {total_results} people</span>
                </div>

                <div className="grid gap-2">
                  {results.map((result, idx) => {
                    const evaluations = parseEvaluations(result.evaluations);
                    const enrichment = parseEnrichmentData(result.enrichment_data);
                    const satisfiedCount = evaluations.filter(e => e.satisfied?.includes('Satisfied.yes')).length;

                    return (
                      <div
                        key={result.id || idx}
                        className="group bg-card border rounded-lg hover:border-primary/30"
                      >
                        <div className="p-3">
                          <div className="flex items-center gap-3">
                            <div className="flex-shrink-0">
                              {result.person_picture_url && result.person_picture_url !== '' ? (
                                <img
                                  src={result.person_picture_url}
                                  alt={result.person_name}
                                  className="w-10 h-10 rounded-full object-cover border border-zinc-200 dark:border-zinc-700"
                                  onError={(e) => {
                                    const target = e.target as HTMLImageElement;
                                    target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='1.5'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'%3E%3C/path%3E%3Ccircle cx='12' cy='7' r='4'%3E%3C/circle%3E%3C/svg%3E";
                                    target.classList.add("bg-zinc-100", "dark:bg-zinc-800", "p-2");
                                  }}
                                />
                              ) : (
                              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center border">
                                <User className="w-5 h-5 text-muted-foreground" />
                              </div>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between mb-1">
                                <div className="flex items-center gap-2">
                                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                                    {result.person_name || 'Unknown Person'}
                                  </h3>
                                </div>
                                
                                <div className="flex items-center gap-1">
                                  {enrichment.email && (
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5">
                                          <Mail className="w-3 h-3" />
                                        </Badge>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        <p>{enrichment.email}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  {evaluations.length > 0 && (
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <Badge 
                                          variant={satisfiedCount > 0 ? "default" : "secondary"}
                                          className={cn(
                                            "text-xs px-1.5 py-0 h-5",
                                            satisfiedCount > 0
                                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                                              : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                                          )}
                                        >
                                          <Award className="w-3 h-3 mr-1" />
                                          {satisfiedCount}/{evaluations.length}
                                        </Badge>
                                      </TooltipTrigger>
                                      <TooltipContent className="max-w-xs">
                                        <div className="space-y-1">
                                          <p className="font-medium">Evaluation Criteria:</p>
                                          {evaluations.map((evaluation, evalIdx) => (
                                            <div key={evalIdx} className="text-xs flex items-center gap-2">
                                              <div className={cn(
                                                "w-2 h-2 rounded-full flex-shrink-0",
                                                evaluation.satisfied?.includes('Satisfied.yes')
                                                  ? "bg-emerald-400"
                                                  : "bg-gray-400"
                                              )} />
                                              <span>{evaluation.criterion}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  
                                  {result.description && (
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <Info className="w-4 h-4 text-muted-foreground hover:text-primary transition-colors" />
                                      </TooltipTrigger>
                                      <TooltipContent className="max-w-sm">
                                        <p className="text-xs whitespace-pre-wrap">{truncateString(result.description, 300)}</p>
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                </div>
                              </div>
                              
                              <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  {result.person_position && (
                                    <div className="flex items-center gap-1 truncate">
                                      <Briefcase className="h-3 w-3 flex-shrink-0" />
                                      <span className="truncate">{truncateString(result.person_position, 30)}</span>
                                    </div>
                                  )}
                                  {result.person_location && (
                                    <div className="flex items-center gap-1 truncate">
                                      <MapPin className="h-3 w-3 flex-shrink-0" />
                                      <span className="truncate">{truncateString(result.person_location, 25)}</span>
                                    </div>
                                  )}
                                </div>
                                
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                                    asChild
                                  >
                                    <a 
                                      href={result.url}
                                      target="_blank" 
                                      rel="noopener noreferrer"
                                    >
                                      <Globe className="h-3 w-3" />
                                      View
                                      <ExternalLink className="h-3 w-3 ml-1" />
                                    </a>
                                  </Button>
                                </div>
                              </div>
                            </div>
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
              <Users className="h-10 w-10 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-semibold mb-2 text-zinc-900 dark:text-zinc-100">
              No People Found
            </h3>
            <div className="bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 w-full max-w-md text-center mb-4 shadow-sm">
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
              <Users className="h-3 w-3 mr-1" />
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
