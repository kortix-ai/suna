import React from 'react';
import {
  Settings,
  CheckCircle,
  AlertTriangle,
  Bot,
  Wrench,
  Plug,
  Calendar,
  Clock,
  Activity,
  Zap,
  Link2
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractGetCurrentAgentConfigData, AgentConfiguration, CustomMcp, AgentpressTool } from './_utils';

export function GetCurrentAgentConfigToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // Defensive check - ensure toolCall is defined
  if (!toolCall) {
    console.warn('GetCurrentAgentConfigToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  const {
    summary,
    configuration,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractGetCurrentAgentConfigData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const formatConfigTime = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'short'
      });
    } catch (e) {
      return dateString;
    }
  };

  const formatToolName = (toolKey: string) => {
    return toolKey
      .replace(/sb_|_tool/g, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase());
  };

  const formatMcpToolName = (toolName: string) => {
    return toolName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getEnabledToolsCount = (tools: Record<string, AgentpressTool>) => {
    return Object.values(tools).filter(tool => tool.enabled).length;
  };

  const getTotalMcpToolsCount = (mcps: CustomMcp[]) => {
    return mcps.reduce((total, mcp) => {
      const enabledTools = mcp.enabledTools || [];
      return total + (Array.isArray(enabledTools) ? enabledTools.length : 0);
    }, 0);
  };

  return (
    <Card className="gap-0 flex border-0 shadow-none p-0 py-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20">
              <Settings className="w-5 h-5 text-zinc-500 dark:text-zinc-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                {toolTitle}
              </CardTitle>
            </div>
          </div>

          {!isStreaming && (
            <Badge
              variant="outline"
              className={cn(
                "text-xs font-medium",
                actualIsSuccess
                  ? "bg-zinc-50 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700"
                  : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
              )}
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              Configuration Loaded
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Settings}
            iconColor="text-zinc-500 dark:text-zinc-400"
            bgColor="bg-gradient-to-b from-zinc-100 to-zinc-50 shadow-inner dark:from-zinc-800/40 dark:to-zinc-900/60"
            title="Loading agent configuration"
            showProgress={true}
          />
        ) : configuration ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-6">
              <div className="space-y-6">
                <div className="border rounded-xl p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800/40 dark:to-zinc-700/20 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center">
                      <Bot className="w-6 h-6 text-zinc-600 dark:text-zinc-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg text-zinc-900 dark:text-zinc-100">
                        {configuration.name}
                      </h3>
                    </div>
                  </div>

                  <div className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">
                    {configuration.description}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                        <Calendar className="w-3 h-3" />
                        <span>Created</span>
                      </div>
                      <p className="text-zinc-700 dark:text-zinc-300 pl-5">
                        {formatConfigTime(configuration.created_at)}
                      </p>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                        <Clock className="w-3 h-3" />
                        <span>Last Updated</span>
                      </div>
                      <p className="text-zinc-700 dark:text-zinc-300 pl-5">
                        {formatConfigTime(configuration.updated_at)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="border rounded-xl p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800/40 dark:to-zinc-700/20 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center">
                        <Wrench className="w-5 h-5 text-zinc-600 dark:text-zinc-400" />
                      </div>
                      <div>
                        <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                          AgentPress Tools
                        </h4>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          Core system capabilities
                        </p>
                      </div>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {getEnabledToolsCount(configuration.agentpress_tools)} enabled
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {Object.entries(configuration.agentpress_tools).map(([key, tool]) => (
                      <div key={key} className="flex items-center justify-between p-3 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <Activity className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                          <div>
                            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                              {formatToolName(key)}
                            </p>
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">
                              {tool.description}
                            </p>
                          </div>
                        </div>
                        <Badge
                          variant={tool.enabled ? "default" : "secondary"}
                          className={cn(
                            "text-xs",
                            tool.enabled 
                              ? "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700"
                              : "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-900/20 dark:text-gray-300 dark:border-gray-800"
                          )}
                        >
                          {tool.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>

                {configuration.custom_mcps.length > 0 && (
                  <div className="border rounded-xl p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-900/40 dark:to-orange-800/20 border border-orange-200 dark:border-orange-800 flex items-center justify-center">
                          <Plug className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                        </div>
                        <div>
                          <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                            Integrations
                          </h4>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            External service connections
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">
                          {configuration.custom_mcps.length} {configuration.custom_mcps.length === 1 ? 'integration' : 'integrations'}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {getTotalMcpToolsCount(configuration.custom_mcps)} tools
                        </Badge>
                      </div>
                    </div>

                    <div className="space-y-3">
                      {configuration.custom_mcps.map((mcp, index) => (
                        <div key={index} className="border rounded-lg p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-zinc-100 to-zinc-50 dark:from-zinc-800/40 dark:to-zinc-700/20 border border-zinc-200 dark:border-zinc-700 flex items-center justify-center">
                                <Link2 className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                              </div>
                              <div>
                                <h5 className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {mcp.name}
                                </h5>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                  Type: {mcp.type}
                                </p>
                              </div>
                            </div>
                            <Badge variant="outline" className="text-xs">
                              {mcp.enabledTools.length} tools
                            </Badge>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                            {mcp.enabledTools.map((tool, toolIndex) => (
                              <div key={toolIndex} className="flex items-center gap-1 p-2 bg-zinc-50 dark:bg-zinc-800/50 rounded text-xs">
                                <Zap className="w-3 h-3 text-zinc-500 dark:text-zinc-400" />
                                <span className="text-zinc-700 dark:text-zinc-300 truncate">
                                  {formatMcpToolName(tool)}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-8 px-6">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-xl mx-auto mb-4 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                <Settings className="h-8 w-8 text-zinc-400" />
              </div>
              <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                No configuration found
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Unable to load agent configuration details
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 