import React from 'react';
import {
  Settings,
  CheckCircle,
  AlertTriangle,
  Wrench,
  User,
  Zap,
  Hash,
  Tag,
  GitBranch,
  Package
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractConfigureProfileForAgentData } from './_utils';

export function ConfigureProfileForAgentToolView({
  name = 'configure-profile-for-agent',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    enabled_tools,
    display_name,
    message,
    total_tools,
    version_id,
    version_name,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractConfigureProfileForAgentData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const formatToolName = (toolName: string) => {
    return toolName
      .replace(/^[A-Z_]+-/, '')
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  const getToolCategory = (toolName: string) => {
    const upperTool = toolName.toUpperCase();
    if (upperTool.includes('SCHEDULE') || upperTool.includes('MEETING')) return 'Meeting';
    if (upperTool.includes('EMAIL') || upperTool.includes('SEND')) return 'Communication';
    if (upperTool.includes('FILE') || upperTool.includes('DOCUMENT')) return 'Files';
    if (upperTool.includes('CALENDAR')) return 'Calendar';
    return 'Integration';
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-600/10 border border-violet-500/20">
              <Settings className="w-5 h-5 text-violet-500 dark:text-violet-400" />
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
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                  : "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800"
              )}
            >
              {actualIsSuccess ? (
                <CheckCircle className="h-3 w-3" />
              ) : (
                <AlertTriangle className="h-3 w-3" />
              )}
              {actualIsSuccess ? 'Configuration updated' : 'Configuration failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Settings}
            iconColor="text-violet-500 dark:text-violet-400"
            bgColor="bg-gradient-to-b from-violet-100 to-violet-50 shadow-inner dark:from-violet-800/40 dark:to-violet-900/60 dark:shadow-violet-950/20"
            title="Configuring profile for agent"
            filePath={display_name ? `"${display_name}"` : undefined}
            showProgress={true}
          />
        ) : enabled_tools.length > 0 || message ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-violet-100 to-violet-50 dark:from-violet-900/40 dark:to-violet-800/20 border border-violet-200 dark:border-violet-800 flex items-center justify-center">
                    <User className="w-6 h-6 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                      {display_name || 'Agent Profile'}
                    </h3>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      Configuration updated successfully
                    </p>
                  </div>
                </div>

                <Separator />

                <div className="text-center">
                  <div className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
                    {total_tools}
                  </div>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">
                    {total_tools === 1 ? 'Tool Configured' : 'Tools Configured'}
                  </p>
                </div>
              </div>

              {enabled_tools.length > 0 && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-violet-500" />
                    <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Enabled Tools
                    </h3>
                    <Badge variant="outline" className="text-xs">
                      {enabled_tools.length}
                    </Badge>
                  </div>

                  <div className="space-y-2">
                    {enabled_tools.map((tool, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-xl"
                      >
                        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-100 to-violet-50 dark:from-violet-900/40 dark:to-violet-800/20 border border-violet-200 dark:border-violet-800 flex items-center justify-center">
                          <Zap className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="font-medium text-zinc-900 dark:text-zinc-100">
                              {formatToolName(tool)}
                            </p>
                            <Badge
                              variant="secondary"
                              className="text-xs bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300"
                            >
                              <Tag className="w-2.5 h-2.5" />
                              {getToolCategory(tool)}
                            </Badge>
                          </div>
                          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                            {tool}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {version_name && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-blue-500" />
                    <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Version Information
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                        <Package className="w-4 h-4" />
                        <span>Version Name</span>
                      </div>
                      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 pl-6">
                        {version_name}
                      </p>
                    </div>

                    {version_id && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                          <Hash className="w-4 h-4" />
                          <span>Version ID</span>
                        </div>
                        <p className="text-xs font-mono text-zinc-600 dark:text-zinc-400 pl-6 break-all">
                          {version_id}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-8 px-6">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-xl mx-auto mb-4 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                <Settings className="h-8 w-8 text-zinc-400" />
              </div>
              <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                No configuration applied
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No tools were configured for this profile
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 