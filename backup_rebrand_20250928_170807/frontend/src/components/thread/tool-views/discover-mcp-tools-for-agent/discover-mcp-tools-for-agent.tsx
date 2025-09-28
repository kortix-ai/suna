import React, { useState } from 'react';
import {
  Search,
  CheckCircle,
  AlertTriangle,
  Wrench,
  Package,
  Zap,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  User,
  Shield,
  Link2,
  Globe
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { extractDiscoverMcpToolsData } from './_utils';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';

export function DiscoverMcpToolsForAgentToolView({
  name = 'discover-mcp-tools-for-agent',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const [isToolsExpanded, setIsToolsExpanded] = useState(false);

  const {
    profile_name,
    toolkit_name,
    toolkit_slug,
    tools,
    tool_names,
    total_tools,
    is_connected,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractDiscoverMcpToolsData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);
  const { data: iconData } = useComposioToolkitIcon(toolkit_slug || '', {
    enabled: !!toolkit_slug
  });

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              <Search className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
              className={cn(
                "text-xs font-medium",
                actualIsSuccess
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                  : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
              )}
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {actualIsSuccess ? 'Tools discovered' : 'Discovery failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Search}
            iconColor="text-purple-500 dark:text-purple-400"
            bgColor="bg-gradient-to-b from-purple-100 to-purple-50 shadow-inner dark:from-purple-800/40 dark:to-purple-900/60 dark:shadow-purple-950/20"
            title="Discovering tools"
            filePath={profile_name ? `"${profile_name}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && profile_name ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              {/* Profile Overview */}
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-muted/50 border flex items-center justify-center overflow-hidden">
                      {iconData?.icon_url ? (
                        <img
                          src={iconData.icon_url}
                          alt={`${toolkit_name} logo`}
                          className="w-8 h-8 object-cover rounded"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent) {
                              parent.innerHTML = `<div class="w-full h-full flex items-center justify-center"><svg class="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg></div>`;
                            }
                          }}
                        />
                      ) : (
                        <Package className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {profile_name}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {toolkit_name || toolkit_slug}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      <Globe className="w-3 h-3 mr-1" />
                      {toolkit_slug}
                    </Badge>
                    <Badge variant="secondary" className={cn(
                      "text-xs",
                      is_connected 
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                        : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
                    )}>
                      <Shield className="w-3 h-3 mr-1" />
                      {is_connected ? 'Connected' : 'Disconnected'}
                    </Badge>
                  </div>
                </div>

                <Separator />
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Wrench className="w-4 h-4" />
                      Discovery Results
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>Tools Found: {total_tools}</div>
                      <div>Profile: {profile_name}</div>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Shield className="w-4 h-4" />
                      Connection Status
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>Status: {is_connected ? 'Active' : 'Inactive'}</div>
                      <div>Service: {toolkit_name || toolkit_slug}</div>
                    </div>
                  </div>
                </div>
              </div>
              {tools && tools.length > 0 && (
                <div className="border rounded-xl p-4 space-y-4">
                  <Collapsible open={isToolsExpanded} onOpenChange={setIsToolsExpanded}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" className="w-full justify-between p-0 h-auto">
                        <div className="flex items-center gap-2 p-2">
                          <Zap className="w-4 h-4" />
                          <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            Available Tools ({total_tools})
                          </h4>
                        </div>
                        {isToolsExpanded ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                    
                    <CollapsibleContent className="space-y-3 mt-3">
                      <div className="grid gap-2">
                        {tools.map((tool, index) => (
                          <div key={index} className="bg-muted/30 rounded-lg p-3 space-y-2">
                            <div className="flex items-center gap-2">
                              <Wrench className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                              <h5 className="font-medium text-sm text-zinc-900 dark:text-zinc-100">
                                {tool.name}
                              </h5>
                            </div>
                            {tool.description && (
                              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                                {tool.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to discover tools. Please ensure the profile is authenticated and try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 