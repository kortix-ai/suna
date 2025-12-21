import React from 'react';
import { useParams } from 'next/navigation';
import {
  Globe,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Search,
  Info,
  Play,
  Database,
  DollarSign,
  ChevronRight,
  Settings,
  Code,
  FileJson,
  Clock,
  FileText,
  Download,
  ExternalLink,
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { FileAttachment } from '@/components/thread/file-attachment';
import { JsonViewer } from '../shared/JsonViewer';
import {
  extractApifySearchData,
  extractApifyActorDetails,
  extractApifyRunData,
  extractApifyRunResultsData,
  extractApifyApprovalData,
} from './_utils';
import { ApifyApprovalCard } from './ApifyApprovalCard';

// View type configurations
const VIEW_CONFIGS = {
  search: {
    title: 'Search Apify Actors',
    icon: Search,
    color: 'from-zinc-500 to-zinc-600',
    bgColor: 'bg-zinc-50 dark:bg-zinc-900/20',
    textColor: 'text-zinc-700 dark:text-zinc-300',
    borderColor: 'border-zinc-200 dark:border-zinc-800',
  },
  details: {
    title: 'Actor Details',
    icon: Info,
    color: 'from-zinc-500 to-zinc-600',
    bgColor: 'bg-zinc-50 dark:bg-zinc-900/20',
    textColor: 'text-zinc-700 dark:text-zinc-300',
    borderColor: 'border-zinc-200 dark:border-zinc-800',
  },
  approval: {
    title: 'Apify Approval Request',
    icon: Clock,
    color: 'from-yellow-500 to-yellow-600',
    bgColor: 'bg-yellow-50 dark:bg-yellow-900/20',
    textColor: 'text-yellow-700 dark:text-yellow-300',
    borderColor: 'border-yellow-200 dark:border-yellow-800',
  },
  run: {
    title: 'Run Apify Actor',
    icon: Play,
    color: 'from-zinc-500 to-zinc-600',
    bgColor: 'bg-zinc-50 dark:bg-zinc-900/20',
    textColor: 'text-zinc-700 dark:text-zinc-300',
    borderColor: 'border-zinc-200 dark:border-zinc-800',
  },
  results: {
    title: 'Actor Results',
    icon: Database,
    color: 'from-zinc-500 to-zinc-600',
    bgColor: 'bg-zinc-50 dark:bg-zinc-900/20',
    textColor: 'text-zinc-700 dark:text-zinc-300',
    borderColor: 'border-zinc-200 dark:border-zinc-800',
  },
};

export function ApifyToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
  project,
  onFileClick,
}: ToolViewProps) {
  const params = useParams();
  const threadId = params?.threadId as string || '';
  
  // Progress state for streaming
  const [progress, setProgress] = React.useState(0);
  const [elapsedTime, setElapsedTime] = React.useState(0);

  React.useEffect(() => {
    if (isStreaming) {
      setProgress(0);
      setElapsedTime(0);
      
      // Progress bar animation
      const progressTimer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            return prevProgress;
          }
          return prevProgress + Math.random() * 3; // Random increment for realistic progress
        });
      }, 500);

      // Elapsed time counter
      const timeTimer = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);

      return () => {
        clearInterval(progressTimer);
        clearInterval(timeTimer);
      };
    } else {
      setProgress(100);
    }
  }, [isStreaming]);

  if (!toolCall) {
    return null;
  }

  const functionName = toolCall.function_name || '';
  
  // Check for approval request first
  const approvalData = extractApifyApprovalData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);
  
  // Determine which function was called
  let viewType: keyof typeof VIEW_CONFIGS = 'search';
  if (functionName.includes('approval') || functionName.includes('request_apify_approval')) {
    viewType = 'approval';
  } else if (functionName.includes('search')) {
    viewType = 'search';
  } else if (functionName.includes('details')) {
    viewType = 'details';
  } else if (functionName.includes('run') && !functionName.includes('results')) {
    viewType = 'run';
  } else if (functionName.includes('results')) {
    viewType = 'results';
  }

  const config = VIEW_CONFIGS[viewType];
  const IconComponent = config.icon;

  const searchData = extractApifySearchData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);
  const detailsData = extractApifyActorDetails(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);
  const runData = extractApifyRunData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);
  const resultsData = extractApifyRunResultsData(toolCall, toolResult, isSuccess, toolTimestamp, assistantTimestamp);

  const actualIsSuccess = viewType === 'search' 
    ? searchData.actualIsSuccess
    : viewType === 'details'
    ? detailsData.actualIsSuccess
    : viewType === 'run'
    ? runData.actualIsSuccess
    : resultsData.actualIsSuccess;

  // Extract input parameters from toolCall
  const inputParams = toolCall.arguments || {};
  
  // Extract output from toolResult
  const outputData = toolResult?.output 
    ? (typeof toolResult.output === 'string' 
        ? (() => {
            try {
              return JSON.parse(toolResult.output);
            } catch {
              return toolResult.output;
            }
          })()
        : toolResult.output)
    : null;
  
  // Render input/output JSON using JsonViewer (identical to BrowserToolView/MCP tools)
  const renderInputOutput = () => {
    const hasInput = inputParams && Object.keys(inputParams).length > 0;
    const hasOutput = outputData !== null && outputData !== undefined;

    if (!hasInput && !hasOutput) return null;

    return (
      <div className="space-y-4">
        {hasInput && (
          <JsonViewer
            data={inputParams}
            title="INPUT"
            defaultExpanded={true}
          />
        )}
        {hasOutput && (
          <JsonViewer
            data={outputData}
            title="OUTPUT"
            defaultExpanded={true}
          />
        )}
      </div>
    );
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn(
              "relative p-2 rounded-lg border shrink-0",
              config.bgColor,
              config.borderColor
            )}>
              <IconComponent className={cn("w-5 h-5", config.textColor)} />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {config.title}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="secondary"
              className={cn(
                "text-xs font-medium",
                actualIsSuccess
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                  : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
              )}
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3 w-3 mr-1" />
              ) : (
                <AlertTriangle className="h-3 w-3 mr-1" />
              )}
              {actualIsSuccess ? 'Success' : 'Failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full py-8 px-6">
            <div className="text-center w-full max-w-md">
              <div className={cn(
                "w-20 h-20 rounded-xl mx-auto mb-6 flex items-center justify-center border-2 shadow-lg",
                `bg-gradient-to-br ${config.color}`,
                "border-white/20"
              )}>
                <Loader2 className="h-10 w-10 animate-spin text-white drop-shadow-sm" />
              </div>
              
              {viewType === 'run' ? (
                <>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                    Running Apify Actor
                  </h3>
                  {inputParams?.actor_id && (
                    <div className="mb-4 p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Actor ID</p>
                      <code className="text-sm font-mono text-zinc-900 dark:text-zinc-100">
                        {inputParams.actor_id}
                      </code>
                    </div>
                  )}
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                    This may take a few moments depending on the actor's complexity...
                  </p>
                </>
              ) : viewType === 'search' ? (
                <>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                    Searching Apify Actors
                  </h3>
                  {inputParams?.query && (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">
                      Query: <span className="font-medium text-zinc-700 dark:text-zinc-300">"{inputParams.query}"</span>
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                    Processing...
                  </h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    Please wait
                  </p>
                </>
              )}

              {/* Progress Bar */}
              <div className="w-full max-w-xs mx-auto mb-4">
                <div className="h-2 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={cn(
                      "h-full transition-all duration-500 ease-out rounded-full",
                      `bg-gradient-to-r ${config.color}`
                    )}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{Math.round(progress)}%</span>
                  {elapsedTime > 0 && (
                    <span>{Math.floor(elapsedTime / 60)}:{(elapsedTime % 60).toString().padStart(2, '0')}</span>
                  )}
                </div>
              </div>

              {/* Status Messages */}
              {viewType === 'run' && (
                <div className="space-y-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <div className="flex items-center gap-2 justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                    <span>Initializing actor run...</span>
                  </div>
                  {elapsedTime > 5 && (
                    <div className="flex items-center gap-2 justify-center">
                      <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                      <span>Executing actor tasks...</span>
                    </div>
                  )}
                  {elapsedTime > 15 && (
                    <div className="flex items-center gap-2 justify-center">
                      <div className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />
                      <span>Collecting results...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-6">
              {/* Approval Request View */}
              {viewType === 'approval' && approvalData && threadId && (
                <ApifyApprovalCard
                  approval={approvalData}
                  threadId={threadId}
                  onApproved={() => {
                    // Optionally refresh or navigate
                  }}
                />
              )}

              {/* Search Results View */}
              {viewType === 'search' && (
                <>
                  {searchData.query && (
                    <div className={cn("p-4 rounded-lg border", config.bgColor, config.borderColor)}>
                      <div className="flex items-center gap-3 mb-2">
                        <div className={cn(
                          "w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border-2",
                          `bg-gradient-to-br ${config.color}`,
                          "border-white/20"
                        )}>
                          <Search className="h-5 w-5 text-white drop-shadow-sm" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm text-zinc-500 dark:text-zinc-400">Search Query</p>
                          <code className="text-sm font-mono font-medium text-zinc-900 dark:text-zinc-100">
                            {searchData.query}
                          </code>
                        </div>
                      </div>
                      {searchData.total > 0 && (
                        <div className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-800">
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            Found {searchData.total} actor{searchData.total !== 1 ? 's' : ''}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {searchData.actors.length > 0 ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                          Results ({searchData.actors.length})
                        </h4>
                        {searchData.total > searchData.actors.length && (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            Showing {searchData.actors.length} of {searchData.total.toLocaleString()}
                          </span>
                        )}
                      </div>
                      {searchData.actors.map((actor, idx) => (
                        <div
                          key={idx}
                          className="p-4 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 hover:shadow-sm transition-all"
                        >
                          <div className="flex items-start justify-between gap-4 mb-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start gap-2 mb-1">
                                <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 text-base leading-tight">
                                  {actor.title || actor.name}
                                </h3>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {actor.is_featured && (
                                    <Badge variant="outline" className="text-xs">
                                      Featured
                                    </Badge>
                                  )}
                                  {actor.is_premium && (
                                    <Badge variant="outline" className="text-xs">
                                      Premium
                                    </Badge>
                                  )}
                                </div>
                              </div>
                              {actor.username && (
                                <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                                  by <span className="font-medium">{actor.username}</span>
                                </p>
                              )}
                            </div>
                          </div>
                          
                          {actor.description && (
                            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3 line-clamp-2 leading-relaxed">
                              {actor.description}
                            </p>
                          )}
                          
                          <div className="flex items-center gap-3 flex-wrap pt-2 border-t border-zinc-100 dark:border-zinc-800">
                            <div className="flex items-center gap-1.5">
                              <code className="text-xs font-mono bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded text-zinc-700 dark:text-zinc-300">
                                {actor.actor_id}
                              </code>
                            </div>
                            {actor.run_count > 0 && (
                              <div className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                                <Play className="h-3.5 w-3.5" />
                                <span className="font-medium">{actor.run_count.toLocaleString()}</span>
                                <span>runs</span>
                              </div>
                            )}
                            {actor.pricing_model && (
                              <Badge variant="outline" className="text-xs">
                                {actor.pricing_model}
                              </Badge>
                            )}
                            {!actor.pricing_model && (
                              <span className="text-xs text-zinc-500 dark:text-zinc-400 italic">
                                Pricing varies
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <div className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center mb-3">
                        <Search className="h-6 w-6 text-zinc-400" />
                      </div>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        No actors found
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* Actor Details View */}
              {viewType === 'details' && (
                <>
                  {/* Actor Header */}
                  <div className="flex items-start gap-4 p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                    {detailsData.imageUrl ? (
                      <img
                        src={detailsData.imageUrl}
                        alt={detailsData.title || detailsData.name || 'Actor'}
                        className="w-16 h-16 rounded-lg object-cover border-2 border-zinc-200 dark:border-zinc-700"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className={cn(
                        "w-16 h-16 rounded-lg flex items-center justify-center shadow-sm border-2 shrink-0",
                        `bg-gradient-to-br ${config.color}`,
                        "border-white/20"
                      )}>
                        <Info className="h-8 w-8 text-white drop-shadow-sm" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100 text-lg mb-1">
                        {detailsData.title || detailsData.name || detailsData.actor_id || 'Actor'}
                      </h3>
                      {detailsData.actor_id && (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 font-mono">
                          {detailsData.actor_id}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Actor Metadata */}
                  <div className="grid grid-cols-2 gap-3">
                    {detailsData.username && (
                      <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Creator</p>
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {detailsData.username}
                        </p>
                      </div>
                    )}
                    {detailsData.stats?.totalRuns !== undefined && (
                      <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">Total Runs</p>
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                          {detailsData.stats.totalRuns.toLocaleString()}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Pricing Information */}
                  {detailsData.pricingInfos && detailsData.pricingInfos.length > 0 && (
                    <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 flex items-center gap-2">
                        <DollarSign className="h-4 w-4" />
                        Pricing
                      </h4>
                      <div className="space-y-2">
                        {detailsData.pricingInfos.map((pricing: any, idx: number) => {
                          const pricePerUnit = pricing.pricePerUnitUsd || 0;
                          const pricePer1K = pricePerUnit * 1000;
                          const model = pricing.pricingModel || 'Unknown';
                          
                          return (
                            <div key={idx} className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                  {pricing.unitName || 'Per Unit'}
                                </span>
                                <Badge variant="outline" className="text-xs">
                                  {model.replace(/_/g, ' ')}
                                </Badge>
                              </div>
                              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                ${pricePer1K.toFixed(2)} / 1K {pricing.unitName?.toLowerCase() || 'units'}
                                {pricePerUnit > 0 && (
                                  <span className="text-xs text-zinc-500 dark:text-zinc-500 ml-1">
                                    (${pricePerUnit.toFixed(6)} per unit)
                                  </span>
                                )}
                              </p>
                              {pricing.reasonForChange && (
                                <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-1 italic">
                                  {pricing.reasonForChange}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Categories */}
                  {detailsData.categories && detailsData.categories.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {detailsData.categories.map((category: string, idx: number) => (
                        <Badge key={idx} variant="outline" className="text-xs">
                          {category.replace(/_/g, ' ')}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Description */}
                  {detailsData.description && (
                    <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                        Description
                      </h4>
                      <div 
                        className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap"
                        dangerouslySetInnerHTML={{ __html: detailsData.description }}
                      />
                    </div>
                  )}

                  {/* Stats */}
                  {detailsData.stats && (
                    <div className="p-4 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
                        Statistics
                      </h4>
                      <div className="grid grid-cols-2 gap-3">
                        {detailsData.stats.totalUsers !== undefined && (
                          <div>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">Total Users</p>
                            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              {detailsData.stats.totalUsers.toLocaleString()}
                            </p>
                          </div>
                        )}
                        {detailsData.stats.actorReviewRating !== undefined && (
                          <div>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">Rating</p>
                            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              {detailsData.stats.actorReviewRating.toFixed(1)} ⭐
                              {detailsData.stats.actorReviewCount && (
                                <span className="text-xs text-zinc-500 dark:text-zinc-500 ml-1">
                                  ({detailsData.stats.actorReviewCount} reviews)
                                </span>
                              )}
                            </p>
                          </div>
                        )}
                        {detailsData.stats.publicActorRunStats30Days && (
                          <div className="col-span-2">
                            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">Last 30 Days</p>
                            <div className="grid grid-cols-4 gap-2 text-xs">
                              <div>
                                <p className="text-zinc-500 dark:text-zinc-400">Total</p>
                                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {detailsData.stats.publicActorRunStats30Days.TOTAL?.toLocaleString() || 0}
                                </p>
                              </div>
                              <div>
                                <p className="text-emerald-600 dark:text-emerald-400">Succeeded</p>
                                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {detailsData.stats.publicActorRunStats30Days.SUCCEEDED?.toLocaleString() || 0}
                                </p>
                              </div>
                              <div>
                                <p className="text-red-600 dark:text-red-400">Failed</p>
                                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {detailsData.stats.publicActorRunStats30Days.FAILED?.toLocaleString() || 0}
                                </p>
                              </div>
                              <div>
                                <p className="text-yellow-600 dark:text-yellow-400">Aborted</p>
                                <p className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {detailsData.stats.publicActorRunStats30Days.ABORTED?.toLocaleString() || 0}
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Input Schema Properties */}
                  {detailsData.inputSchema && detailsData.inputSchema.properties && (
                    <div className="p-4 bg-zinc-50 dark:bg-zinc-900/10 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3 flex items-center gap-2">
                        <Settings className="h-4 w-4" />
                        Input Schema Properties
                      </h4>
                      <div className="space-y-3">
                        {Object.entries(detailsData.inputSchema.properties).map(([key, prop]: [string, any]) => {
                          const sectionCaption = prop.sectionCaption;
                          const isNewSection = sectionCaption && 
                            (key === Object.keys(detailsData.inputSchema.properties)[0] || 
                             detailsData.inputSchema.properties[Object.keys(detailsData.inputSchema.properties)[Object.keys(detailsData.inputSchema.properties).indexOf(key) - 1]]?.sectionCaption !== sectionCaption);
                          
                          return (
                            <div key={key}>
                              {isNewSection && sectionCaption && (
                                <h5 className="text-xs font-semibold text-zinc-600 dark:text-zinc-400 mb-2 mt-3 first:mt-0">
                                  {sectionCaption}
                                </h5>
                              )}
                              <div className="p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                                <div className="flex items-start justify-between gap-2 mb-1">
                                  <div className="flex-1">
                                    <div className="flex items-center gap-2 mb-1">
                                      <code className="text-xs font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                                        {key}
                                      </code>
                                      {prop.type && (
                                        <Badge variant="outline" className="text-xs">
                                          {prop.type}
                                        </Badge>
                                      )}
                                      {prop.required && (
                                        <Badge variant="outline" className="text-xs bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700">
                                          Required
                                        </Badge>
                                      )}
                                    </div>
                                    {prop.title && (
                                      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                                        {prop.title}
                                      </p>
                                    )}
                                    {prop.description && (
                                      <div 
                                        className="text-xs text-zinc-600 dark:text-zinc-400 mb-2"
                                        dangerouslySetInnerHTML={{ __html: prop.description }}
                                      />
                                    )}
                                    {prop.default !== undefined && (
                                      <div className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">
                                        <span className="font-medium">Default:</span>{' '}
                                        <code className="bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                                          {typeof prop.default === 'object' ? JSON.stringify(prop.default) : String(prop.default)}
                                        </code>
                                      </div>
                                    )}
                                    {prop.enum && Array.isArray(prop.enum) && (
                                      <div className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">
                                        <span className="font-medium">Options:</span>{' '}
                                        <span className="text-zinc-600 dark:text-zinc-400">
                                          {prop.enum.join(', ')}
                                        </span>
                                      </div>
                                    )}
                                    {prop.minimum !== undefined && (
                                      <div className="text-xs text-zinc-500 dark:text-zinc-500 mt-1">
                                        <span className="font-medium">Min:</span> {prop.minimum}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  
                </>
              )}

              {/* Run Actor View */}
              {viewType === 'run' && (
                <>
                  <div className="flex items-center gap-4 p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <div className={cn(
                      "w-12 h-12 rounded-lg flex items-center justify-center shadow-sm border-2",
                      `bg-gradient-to-br ${config.color}`,
                      "border-white/20"
                    )}>
                      <Play className="h-6 w-6 text-white drop-shadow-sm" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {runData.actor_id}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-xs">
                          {runData.status}
                        </Badge>
                        {runData.run_id && (
                          <code className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                            {runData.run_id.slice(0, 12)}...
                          </code>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* Cost and Summary */}
                  {(runData.cost_deducted || runData.total_items > 0) && (
                    <div className="grid grid-cols-2 gap-3">
                      {runData.cost_deducted && (
                        <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                          <div className="flex items-center gap-2 mb-1">
                            <DollarSign className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                            <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                              Cost
                            </h4>
                          </div>
                          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {runData.cost_deducted}
                          </p>
                        </div>
                      )}
                      {runData.total_items > 0 && (
                        <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                          <div className="flex items-center gap-2 mb-1">
                            <Database className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
                            <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                              Items
                            </h4>
                          </div>
                          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            {runData.total_items.toLocaleString()}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {/* File Saved to Disk - Show File Preview */}
                  {runData.saved_to_disk && runData.file_path && (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        <FileJson className="h-4 w-4" />
                        <span>Results File</span>
                        {runData.total_items > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {runData.total_items.toLocaleString()} items
                          </Badge>
                        )}
                      </div>
                      <FileAttachment
                        filepath={runData.file_path}
                        sandboxId={project?.sandbox?.id}
                        showPreview={true}
                        collapsed={false}
                        project={project}
                        onClick={onFileClick}
                        className="w-full min-h-[240px] max-h-[400px] overflow-auto"
                        customStyle={{
                          gridColumn: '1 / -1',
                          width: '100%'
                        }}
                      />
                      {runData.message && (
                        <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                          <p className="text-xs text-zinc-600 dark:text-zinc-400">
                            {runData.message.replace(/^✅\s*/, '')}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* Show results preview only if not saved to disk */}
                  {!runData.saved_to_disk && runData.results.length > 0 && (
                    <div className="space-y-3">
                      <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        Results Preview ({Math.min(runData.results.length, 5)} of {runData.total_items})
                      </h4>
                      <div className="space-y-2">
                        {runData.results.slice(0, 5).map((result, idx) => (
                          <details key={idx} className="group">
                            <summary className="flex items-center gap-2 text-sm cursor-pointer hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                              <Database className="h-4 w-4 text-zinc-400" />
                              <span className="text-zinc-600 dark:text-zinc-400">Item {idx + 1}</span>
                              <ChevronRight className="h-3 w-3 ml-auto text-zinc-400 group-open:rotate-90 transition-transform" />
                            </summary>
                            <div className="mt-2 p-3 bg-zinc-900 dark:bg-zinc-950 rounded-lg border border-zinc-200 dark:border-zinc-800">
                              <pre className="text-xs font-mono text-emerald-400 dark:text-emerald-300 overflow-x-auto">
                                {JSON.stringify(result, null, 2)}
                              </pre>
                            </div>
                          </details>
                        ))}
                        {runData.results.length > 5 && (
                          <div className="text-center text-xs text-zinc-500 dark:text-zinc-400 py-2">
                            ... and {runData.results.length - 5} more items
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Show message if saved to disk but no file path yet */}
                  {runData.saved_to_disk && !runData.file_path && runData.message && (
                    <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {runData.message}
                      </p>
                    </div>
                  )}
                  
                  {runData.dataset_id && (
                    <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                      <div className="flex items-center gap-2 text-sm">
                        <Database className="h-4 w-4 text-zinc-500 dark:text-zinc-400" />
                        <span className="text-zinc-600 dark:text-zinc-400">Dataset ID:</span>
                        <code className="font-mono text-xs text-zinc-900 dark:text-zinc-100">{runData.dataset_id}</code>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Run Results View - Always shows file saved to disk */}
              {viewType === 'results' && (
                <>
                  <div className="flex items-center gap-4 p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                    <div className={cn(
                      "w-12 h-12 rounded-lg flex items-center justify-center shadow-sm border-2",
                      `bg-gradient-to-br ${config.color}`,
                      "border-white/20"
                    )}>
                      <Database className="h-6 w-6 text-white drop-shadow-sm" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        Run Results
                      </h3>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        {resultsData.item_count > 0 
                          ? `${resultsData.item_count.toLocaleString()} items saved to disk`
                          : 'Results saved to disk'}
                      </p>
                    </div>
                  </div>
                  
                  {/* File Saved to Disk - Show File Preview */}
                  {resultsData.saved_to_disk && resultsData.file_path ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                        <FileJson className="h-4 w-4" />
                        <span>Results File</span>
                        {resultsData.item_count > 0 && (
                          <Badge variant="outline" className="text-xs">
                            {resultsData.item_count.toLocaleString()} items
                          </Badge>
                        )}
                      </div>
                      <FileAttachment
                        filepath={resultsData.file_path}
                        sandboxId={project?.sandbox?.id}
                        showPreview={true}
                        collapsed={false}
                        project={project}
                        onClick={onFileClick}
                        className="w-full min-h-[240px] max-h-[400px] overflow-auto"
                        customStyle={{
                          gridColumn: '1 / -1',
                          width: '100%'
                        }}
                      />
                      {resultsData.message && (
                        <div className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
                          <p className="text-xs text-zinc-600 dark:text-zinc-400">
                            {resultsData.message.replace(/^✅\s*/, '')}
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <div className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center mb-3">
                        <Database className="h-6 w-6 text-zinc-400" />
                      </div>
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">
                        {resultsData.message || 'No results file found'}
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* Input/Output JSON - At the bottom (same as MCP tools) */}
              {renderInputOutput()}
            </div>
          </ScrollArea>
        )}
      </CardContent>
      
      <div className="px-4 py-2 h-10 bg-zinc-50/50 dark:bg-zinc-900/50 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (
            <Badge variant="outline" className="h-6 py-0.5 text-xs">
              <Globe className="h-3 w-3 mr-1" />
              Apify
            </Badge>
          )}
        </div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {viewType === 'search' && searchData.actualToolTimestamp && !isStreaming
            ? formatTimestamp(searchData.actualToolTimestamp)
            : viewType === 'details' && detailsData.actualToolTimestamp && !isStreaming
            ? formatTimestamp(detailsData.actualToolTimestamp)
            : viewType === 'run' && runData.actualToolTimestamp && !isStreaming
            ? formatTimestamp(runData.actualToolTimestamp)
            : viewType === 'results' && resultsData.actualToolTimestamp && !isStreaming
            ? formatTimestamp(resultsData.actualToolTimestamp)
            : assistantTimestamp
            ? formatTimestamp(assistantTimestamp)
            : ''}
        </div>
      </div>
    </Card>
  );
}
