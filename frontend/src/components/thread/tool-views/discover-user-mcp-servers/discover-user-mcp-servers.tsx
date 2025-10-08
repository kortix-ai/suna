import React from 'react';
import {
  Search,
  CheckCircle,
  AlertTriangle,
  Plug,
  Zap,
  Package,
  Link2,
  Wrench,
  ChevronRight,
  Database
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractDiscoverUserMcpServersData, McpTool } from './_utils';

export function DiscoverUserMcpServersToolView({
  name = 'discover-user-mcp-servers',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    profile_id,
    message,
    profile_info,
    tools,
    total_tools,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractDiscoverUserMcpServersData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const formatToolName = (toolName: string): string => {
    return toolName
      .replace(/^LINEAR_/, '')
      .replace(/_/g, ' ')
      .split(' ')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getToolCategory = (toolName: string): string => {
    if (toolName.includes('CREATE')) return 'Create';
    if (toolName.includes('UPDATE')) return 'Update';
    if (toolName.includes('DELETE') || toolName.includes('REMOVE')) return 'Delete';
    if (toolName.includes('GET') || toolName.includes('LIST')) return 'Read';
    if (toolName.includes('RUN')) return 'Advanced';
    return 'Other';
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'Create':
        return <span className="text-green-500">+</span>;
      case 'Update':
        return <span className="text-blue-500">✎</span>;
      case 'Delete':
        return <span className="text-red-500">×</span>;
      case 'Read':
        return <span className="text-purple-500">⊙</span>;
      case 'Advanced':
        return <span className="text-orange-500">⚡</span>;
      default:
        return <span className="text-gray-500">•</span>;
    }
  };

  const groupToolsByCategory = (tools: McpTool[]) => {
    const grouped: Record<string, McpTool[]> = {};
    tools.forEach(tool => {
      const category = getToolCategory(tool.name);
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(tool);
    });
    return grouped;
  };

  const groupedTools = groupToolsByCategory(tools);
  const categoryOrder = ['Read', 'Create', 'Update', 'Delete', 'Advanced', 'Other'];

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
            title="Discovering MCP tools"
            showProgress={true}
          />
        ) : actualIsSuccess && profile_info ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-100 to-purple-50 dark:from-purple-900/40 dark:to-purple-800/20 border border-purple-200 dark:border-purple-800 flex items-center justify-center">
                      <Plug className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg text-zinc-900 dark:text-zinc-100">
                        {profile_info.profile_name}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {profile_info.toolkit_name} Integration
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={profile_info.is_connected ? "default" : "secondary"}
                      className={cn(
                        "text-xs",
                        profile_info.is_connected 
                          ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800"
                          : "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-900/20 dark:text-gray-300 dark:border-gray-800"
                      )}
                    >
                      {profile_info.is_connected ? (
                        <>
                          <Link2 className="h-3 w-3 mr-1" />
                          Connected
                        </>
                      ) : 'Disconnected'}
                    </Badge>
                  </div>
                </div>
              </div>

              {tools.length > 0 && (
                <div className="border rounded-xl p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Wrench className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                      <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                        Discovered Tools
                      </h4>
                    </div>
                    <Badge variant="outline" className="text-xs">
                      {total_tools} available
                    </Badge>
                  </div>
                  
                  <Separator />

                  <div className="space-y-4">
                    {categoryOrder.map(category => {
                      if (!groupedTools[category] || groupedTools[category].length === 0) return null;
                      
                      return (
                        <div key={category} className="space-y-2">
                          <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                            <span className="w-5 h-5 flex items-center justify-center">
                              {getCategoryIcon(category)}
                            </span>
                            <span>{category} Operations</span>
                            <Badge variant="secondary" className="text-xs ml-auto">
                              {groupedTools[category].length}
                            </Badge>
                          </div>
                          
                          <div className="space-y-2 pl-7">
                            {groupedTools[category].map((tool, index) => (
                              <div key={index} className="border rounded-lg p-3 space-y-2 bg-zinc-50/50 dark:bg-zinc-800/30">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="flex-1 space-y-1">
                                    <div className="flex items-center gap-2">
                                      <Zap className="w-3 h-3 text-purple-500 dark:text-purple-400" />
                                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                        {formatToolName(tool.name)}
                                      </p>
                                    </div>
                                    <p className="text-xs text-zinc-600 dark:text-zinc-400 pl-5">
                                      {tool.description}
                                    </p>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {tools.length === 0 && (
                <div className="border rounded-xl p-6 text-center">
                  <Package className="w-12 h-12 mx-auto text-zinc-400 dark:text-zinc-600 mb-3" />
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    No tools discovered for this profile
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to discover MCP tools. Please check the profile configuration.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
