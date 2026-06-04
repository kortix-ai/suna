import React, { useState, useEffect } from 'react';
import { View, ScrollView, Image, Pressable, Linking } from 'react-native';
import { Text } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import {
  Globe,
  CheckCircle,
  AlertTriangle,
  Search,
  Info,
  Play,
  Database,
  DollarSign,
  ChevronRight,
  Settings,
  FileJson,
  Clock,
  FileText,
  ExternalLink,
} from 'lucide-react-native';
import { ToolViewProps } from '../types';
import { ToolViewCard, LoadingState, JsonViewer } from '../shared';
import { FileAttachmentRenderer } from '@/components/chat/FileAttachmentRenderer';
import {
  extractApifySearchData,
  extractApifyActorDetails,
  extractApifyRunData,
  extractApifyRunResultsData,
  extractApifyApprovalData,
} from './_utils';
import { ApifyApprovalView } from '../apify-approval/ApifyApprovalView';

// Utility function
function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

// View type configurations
const VIEW_CONFIGS = {
  search: {
    title: 'Search Apify Actors',
    icon: Search,
    iconColor: 'text-zinc-600 dark:text-zinc-400',
    iconBgColor: 'bg-zinc-100 dark:bg-zinc-800',
  },
  details: {
    title: 'Actor Details',
    icon: Info,
    iconColor: 'text-zinc-600 dark:text-zinc-400',
    iconBgColor: 'bg-zinc-100 dark:bg-zinc-800',
  },
  approval: {
    title: 'Apify Approval Request',
    icon: Clock,
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    iconBgColor: 'bg-yellow-100 dark:bg-yellow-900/20',
  },
  run: {
    title: 'Run Apify Actor',
    icon: Play,
    iconColor: 'text-zinc-600 dark:text-zinc-400',
    iconBgColor: 'bg-zinc-100 dark:bg-zinc-800',
  },
  results: {
    title: 'Actor Results',
    icon: Database,
    iconColor: 'text-zinc-600 dark:text-zinc-400',
    iconBgColor: 'bg-zinc-100 dark:bg-zinc-800',
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
  threadId,
  onFileClick,
}: ToolViewProps) {
  const [progress, setProgress] = useState(0);
  const [elapsedTime, setElapsedTime] = useState(0);

  useEffect(() => {
    if (isStreaming) {
      setProgress(0);
      setElapsedTime(0);
      
      const progressTimer = setInterval(() => {
        setProgress((prevProgress) => {
          if (prevProgress >= 95) {
            return prevProgress;
          }
          return prevProgress + Math.random() * 3;
        });
      }, 500);

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
  if (functionName.includes('approval') || functionName.includes('request_apify_approval') || functionName.includes('approve_apify_request')) {
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
    : viewType === 'approval'
    ? (approvalData?.actualIsSuccess ?? isSuccess)
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
  
  // Render input/output JSON
  const renderInputOutput = () => {
    const hasInput = inputParams && Object.keys(inputParams).length > 0;
    const hasOutput = outputData !== null && outputData !== undefined;

    if (!hasInput && !hasOutput) return null;

    return (
      <View className="gap-4">
        {hasInput && (
          <View className="gap-2">
            <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">
              Input
            </Text>
            <JsonViewer data={inputParams} title="INPUT" defaultExpanded={true} />
          </View>
        )}
        {hasOutput && (
          <View className="gap-2">
            <Text className="px-1 font-roobert-medium text-xs uppercase tracking-wider text-primary opacity-60">
              Output
            </Text>
            <JsonViewer data={outputData} title="OUTPUT" defaultExpanded={true} />
          </View>
        )}
      </View>
    );
  };

  // If approval view, use the dedicated approval component
  if (viewType === 'approval' && approvalData && threadId) {
    return (
      <ApifyApprovalView
        toolCall={toolCall}
        toolResult={toolResult}
        threadId={threadId}
        isSuccess={isSuccess}
      />
    );
  }

  return (
    <ToolViewCard
      header={{
        icon: IconComponent,
        iconColor: config.iconColor,
        iconBgColor: config.iconBgColor,
        subtitle: 'Apify',
        title: config.title,
        isSuccess: actualIsSuccess,
        showStatus: true,
        isStreaming: isStreaming,
      }}
    >
      {isStreaming ? (
        <LoadingState
          icon={IconComponent}
          iconColor={config.iconColor}
          bgColor={config.iconBgColor}
          title={
            viewType === 'run' 
              ? 'Running Apify Actor'
              : viewType === 'search'
              ? 'Searching Apify Actors'
              : 'Processing...'
          }
          subtitle={
            viewType === 'run'
              ? 'This may take a few moments depending on the actor\'s complexity...'
              : undefined
          }
          showProgress={true}
          progressText={
            viewType === 'run' && elapsedTime > 5
              ? elapsedTime > 15
                ? 'Collecting results...'
                : 'Executing actor tasks...'
              : 'Initializing...'
          }
        />
      ) : (
        <ScrollView className="flex-1" showsVerticalScrollIndicator={true}>
          <View className="gap-6 p-4">
            {/* Search Results View */}
            {viewType === 'search' && (
              <>
                {searchData.query && (
                  <View className="p-4 rounded-xl border border-border bg-card">
                    <View className="flex-row items-center gap-3 mb-2">
                      <View className="w-10 h-10 rounded-lg bg-zinc-100 dark:bg-zinc-800 items-center justify-center">
                        <Search size={20} color="#71717a" />
                      </View>
                      <View className="flex-1">
                        <Text className="text-xs text-muted-foreground">Search Query</Text>
                        <Text className="text-sm font-roobert-mono font-medium text-primary">
                          {searchData.query}
                        </Text>
                      </View>
                    </View>
                    {searchData.total > 0 && (
                      <View className="mt-2 pt-2 border-t border-border">
                        <Text className="text-xs text-muted-foreground">
                          Found {searchData.total} actor{searchData.total !== 1 ? 's' : ''}
                        </Text>
                      </View>
                    )}
                  </View>
                )}
                
                {searchData.actors.length > 0 ? (
                  <View className="gap-3">
                    <View className="flex-row items-center justify-between">
                      <Text className="text-sm font-roobert-medium text-primary">
                        Results ({searchData.actors.length})
                      </Text>
                      {searchData.total > searchData.actors.length && (
                        <Text className="text-xs text-muted-foreground">
                          Showing {searchData.actors.length} of {searchData.total.toLocaleString()}
                        </Text>
                      )}
                    </View>
                    {searchData.actors.map((actor, idx) => (
                      <View
                        key={idx}
                        className="p-4 bg-card rounded-xl border border-border"
                      >
                        <View className="flex-row items-start justify-between gap-4 mb-3">
                          <View className="flex-1 min-w-0">
                            <View className="flex-row items-start gap-2 mb-1">
                              <Text className="font-roobert-semibold text-base text-primary flex-1">
                                {actor.title || actor.name}
                              </Text>
                              <View className="flex-row items-center gap-1.5">
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
                              </View>
                            </View>
                            {actor.username && (
                              <Text className="text-xs text-muted-foreground mb-2">
                                by <Text className="font-roobert-medium">{actor.username}</Text>
                              </Text>
                            )}
                          </View>
                        </View>
                        
                        {actor.description && (
                          <Text className="text-sm text-muted-foreground mb-3" numberOfLines={2}>
                            {actor.description}
                          </Text>
                        )}
                        
                        <View className="flex-row items-center gap-3 flex-wrap pt-2 border-t border-border">
                          <View className="flex-row items-center gap-1.5">
                            <Text className="text-xs font-roobert-mono bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded text-primary">
                              {actor.actor_id}
                            </Text>
                          </View>
                          {actor.run_count > 0 && (
                            <View className="flex-row items-center gap-1.5">
                              <Icon as={Play} size={14} className="text-muted-foreground" />
                              <Text className="text-xs text-muted-foreground">
                                <Text className="font-roobert-medium">{actor.run_count.toLocaleString()}</Text> runs
                              </Text>
                            </View>
                          )}
                          {actor.pricing_model && (
                            <Badge variant="outline" className="text-xs">
                              {actor.pricing_model}
                            </Badge>
                          )}
                        </View>
                      </View>
                    ))}
                  </View>
                ) : (
                  <View className="items-center justify-center py-12">
                    <View className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-border items-center justify-center mb-3">
                      <Search size={24} color="#71717a" />
                    </View>
                    <Text className="text-sm text-muted-foreground">
                      No actors found
                    </Text>
                  </View>
                )}
              </>
            )}

            {/* Actor Details View */}
            {viewType === 'details' && (
              <>
                <View className="flex-row items-start gap-4 p-4 bg-card rounded-xl border border-border">
                  {detailsData.imageUrl ? (
                    <Image
                      source={{ uri: detailsData.imageUrl }}
                      className="w-16 h-16 rounded-lg"
                      style={{ borderWidth: 2, borderColor: '#e4e4e7' }}
                      onError={() => {}}
                    />
                  ) : (
                    <View className="w-16 h-16 rounded-lg bg-zinc-100 dark:bg-zinc-800 items-center justify-center">
                      <Info size={32} color="#71717a" />
                    </View>
                  )}
                  <View className="flex-1 min-w-0">
                    <Text className="font-roobert-semibold text-lg text-primary mb-1">
                      {detailsData.title || detailsData.name || detailsData.actor_id || 'Actor'}
                    </Text>
                    {detailsData.actor_id && (
                      <Text className="text-sm text-muted-foreground font-roobert-mono">
                        {detailsData.actor_id}
                      </Text>
                    )}
                  </View>
                </View>

                <View className="flex-row gap-3">
                  {detailsData.username && (
                    <View className="flex-1 p-3 bg-card rounded-xl border border-border">
                      <Text className="text-xs text-muted-foreground mb-1">Creator</Text>
                      <Text className="text-sm font-roobert-medium text-primary">
                        {detailsData.username}
                      </Text>
                    </View>
                  )}
                  {detailsData.stats?.totalRuns !== undefined && (
                    <View className="flex-1 p-3 bg-card rounded-xl border border-border">
                      <Text className="text-xs text-muted-foreground mb-1">Total Runs</Text>
                      <Text className="text-sm font-roobert-medium text-primary">
                        {detailsData.stats.totalRuns.toLocaleString()}
                      </Text>
                    </View>
                  )}
                </View>

                {/* Pricing Information */}
                {detailsData.pricingInfos && detailsData.pricingInfos.length > 0 && (
                  <View className="p-4 bg-card rounded-xl border border-border">
                    <View className="flex-row items-center gap-2 mb-3">
                      <Icon as={DollarSign} size={16} className="text-primary" />
                      <Text className="text-sm font-roobert-medium text-primary">Pricing</Text>
                    </View>
                    <View className="gap-2">
                      {detailsData.pricingInfos.map((pricing: any, idx: number) => {
                        const pricePerUnit = pricing.pricePerUnitUsd || 0;
                        const pricePer1K = pricePerUnit * 1000;
                        const model = pricing.pricingModel || 'Unknown';
                        
                        return (
                          <View key={idx} className="p-3 bg-zinc-50 dark:bg-zinc-900/50 rounded-xl border border-border">
                            <View className="flex-row items-center justify-between mb-1">
                              <Text className="text-sm font-roobert-medium text-primary">
                                {pricing.unitName || 'Per Unit'}
                              </Text>
                              <Badge variant="outline" className="text-xs">
                                {model.replace(/_/g, ' ')}
                              </Badge>
                            </View>
                            <Text className="text-sm text-muted-foreground">
                              ${pricePer1K.toFixed(2)} / 1K {pricing.unitName?.toLowerCase() || 'units'}
                              {pricePerUnit > 0 && (
                                <Text className="text-xs text-muted-foreground ml-1">
                                  (${pricePerUnit.toFixed(6)} per unit)
                                </Text>
                              )}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* Categories */}
                {detailsData.categories && detailsData.categories.length > 0 && (
                  <View className="flex-row flex-wrap gap-2">
                    {detailsData.categories.map((category: string, idx: number) => (
                      <Badge key={idx} variant="outline" className="text-xs">
                        {category.replace(/_/g, ' ')}
                      </Badge>
                    ))}
                  </View>
                )}

                {/* Description */}
                {detailsData.description && (
                  <View className="p-4 bg-card rounded-xl border border-border">
                    <Text className="text-sm font-roobert-medium text-primary mb-2">
                      Description
                    </Text>
                    <Text className="text-sm text-muted-foreground whitespace-pre-wrap">
                      {detailsData.description.replace(/<[^>]*>/g, '')}
                    </Text>
                  </View>
                )}

                {/* Stats */}
                {detailsData.stats && (
                  <View className="p-4 bg-card rounded-xl border border-border">
                    <Text className="text-sm font-roobert-medium text-primary mb-3">
                      Statistics
                    </Text>
                    <View className="gap-3">
                      {detailsData.stats.totalUsers !== undefined && (
                        <View>
                          <Text className="text-xs text-muted-foreground">Total Users</Text>
                          <Text className="text-sm font-roobert-medium text-primary">
                            {detailsData.stats.totalUsers.toLocaleString()}
                          </Text>
                        </View>
                      )}
                      {detailsData.stats.actorReviewRating !== undefined && (
                        <View>
                          <Text className="text-xs text-muted-foreground">Rating</Text>
                          <Text className="text-sm font-roobert-medium text-primary">
                            {detailsData.stats.actorReviewRating.toFixed(1)} ⭐
                            {detailsData.stats.actorReviewCount && (
                              <Text className="text-xs text-muted-foreground ml-1">
                                ({detailsData.stats.actorReviewCount} reviews)
                              </Text>
                            )}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                )}
              </>
            )}

            {/* Run Actor View */}
            {viewType === 'run' && (
              <>
                <View className="flex-row items-center gap-4 p-4 bg-card rounded-xl border border-border">
                  <View className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 items-center justify-center">
                    <Play size={24} color="#71717a" />
                  </View>
                  <View className="flex-1">
                    <Text className="font-roobert-semibold text-primary">
                      {runData.actor_id}
                    </Text>
                    <View className="flex-row items-center gap-2 mt-1">
                      <Badge variant="outline" className="text-xs">
                        {runData.status}
                      </Badge>
                      {runData.run_id && (
                        <Text className="text-xs text-muted-foreground font-roobert-mono">
                          {runData.run_id.slice(0, 12)}...
                        </Text>
                      )}
                    </View>
                  </View>
                </View>
                
                {/* Cost and Summary */}
                {(runData.cost_deducted || runData.total_items > 0) && (
                  <View className="flex-row gap-3">
                    {runData.cost_deducted && (
                      <View className="flex-1 p-3 bg-card rounded-xl border border-border">
                        <View className="flex-row items-center gap-2 mb-1">
                          <Icon as={DollarSign} size={14} className="text-muted-foreground" />
                          <Text className="text-xs font-roobert-medium text-muted-foreground uppercase">
                            Cost
                          </Text>
                        </View>
                        <Text className="text-sm font-roobert-semibold text-primary">
                          {runData.cost_deducted}
                        </Text>
                      </View>
                    )}
                    {runData.total_items > 0 && (
                      <View className="flex-1 p-3 bg-card rounded-xl border border-border">
                        <View className="flex-row items-center gap-2 mb-1">
                          <Icon as={Database} size={14} className="text-muted-foreground" />
                          <Text className="text-xs font-roobert-medium text-muted-foreground uppercase">
                            Items
                          </Text>
                        </View>
                        <Text className="text-sm font-roobert-semibold text-primary">
                          {runData.total_items.toLocaleString()}
                        </Text>
                      </View>
                    )}
                  </View>
                )}

                {/* File Saved to Disk */}
                {runData.saved_to_disk && runData.file_path && project?.sandbox?.id && (
                  <View className="gap-3">
                    <View className="flex-row items-center gap-2">
                      <Icon as={FileJson} size={16} className="text-primary" />
                      <Text className="text-sm font-roobert-medium text-primary">
                        Results File
                      </Text>
                      {runData.total_items > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {runData.total_items.toLocaleString()} items
                        </Badge>
                      )}
                    </View>
                    <FileAttachmentRenderer
                      filePath={runData.file_path}
                      sandboxId={project.sandbox.id}
                      sandboxUrl={project.sandbox.sandbox_url}
                      showPreview={true}
                      onPress={onFileClick}
                    />
                    {runData.message && (
                      <View className="p-3 bg-card rounded-xl border border-border">
                        <Text className="text-xs text-muted-foreground">
                          {runData.message.replace(/^✅\s*/, '')}
                        </Text>
                      </View>
                    )}
                  </View>
                )}

                {runData.dataset_id && (
                  <View className="p-3 bg-card rounded-xl border border-border">
                    <View className="flex-row items-center gap-2">
                      <Icon as={Database} size={16} className="text-muted-foreground" />
                      <Text className="text-sm text-muted-foreground">Dataset ID:</Text>
                      <Text className="text-xs font-roobert-mono text-primary">{runData.dataset_id}</Text>
                    </View>
                  </View>
                )}
              </>
            )}

            {/* Run Results View */}
            {viewType === 'results' && (
              <>
                <View className="flex-row items-center gap-4 p-4 bg-card rounded-xl border border-border">
                  <View className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 items-center justify-center">
                    <Database size={24} color="#71717a" />
                  </View>
                  <View className="flex-1">
                    <Text className="font-roobert-semibold text-primary">
                      Run Results
                    </Text>
                    <Text className="text-sm text-muted-foreground">
                      {resultsData.item_count > 0 
                        ? `${resultsData.item_count.toLocaleString()} items saved to disk`
                        : 'Results saved to disk'}
                    </Text>
                  </View>
                </View>
                
                {/* File Saved to Disk */}
                {resultsData.saved_to_disk && resultsData.file_path && project?.sandbox?.id ? (
                  <View className="gap-3">
                    <View className="flex-row items-center gap-2">
                      <Icon as={FileJson} size={16} className="text-primary" />
                      <Text className="text-sm font-roobert-medium text-primary">
                        Results File
                      </Text>
                      {resultsData.item_count > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {resultsData.item_count.toLocaleString()} items
                        </Badge>
                      )}
                    </View>
                    <FileAttachmentRenderer
                      filePath={resultsData.file_path}
                      sandboxId={project.sandbox.id}
                      sandboxUrl={project.sandbox.sandbox_url}
                      showPreview={true}
                      onPress={onFileClick}
                    />
                    {resultsData.message && (
                      <View className="p-3 bg-card rounded-xl border border-border">
                        <Text className="text-xs text-muted-foreground">
                          {resultsData.message.replace(/^✅\s*/, '')}
                        </Text>
                      </View>
                    )}
                  </View>
                ) : (
                  <View className="items-center justify-center py-12">
                    <View className="w-12 h-12 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-border items-center justify-center mb-3">
                      <Database size={24} color="#71717a" />
                    </View>
                    <Text className="text-sm text-muted-foreground">
                      {resultsData.message || 'No results file found'}
                    </Text>
                  </View>
                )}
              </>
            )}

            {/* Input/Output JSON */}
            {renderInputOutput()}
          </View>
        </ScrollView>
      )}
    </ToolViewCard>
  );
}

