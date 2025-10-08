import React from 'react';
import {
  Bot,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Sparkles,
  User,
  RefreshCw,
  History,
  Edit3
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractUpdateAgentData } from './_utils';
import { AgentAvatar } from '../../content/agent-avatar';

export function UpdateAgentToolView({
  name = 'update-agent',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    name: agentName,
    description,
    system_prompt,
    icon_name,
    icon_color,
    icon_background,
    agentpress_tools,
    configured_mcps,
    is_default,
    agent,
    updated_fields,
    version_created,
    message,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractUpdateAgentData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const getEnabledToolsCount = () => {
    if (!agentpress_tools) return 0;
    return Object.values(agentpress_tools).filter(Boolean).length;
  };

  const formatFieldName = (field: string): string => {
    return field
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const displayName = agent?.name || agentName;
  const displayIconName = agent?.icon_name || icon_name;
  const displayIconColor = agent?.icon_color || icon_color;
  const displayIconBackground = agent?.icon_background || icon_background;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <RefreshCw className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Agent updated' : 'Update failed'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={RefreshCw}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Updating agent"
            filePath={displayName ? `"${displayName}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && agent ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <AgentAvatar
                      iconName={displayIconName}
                      iconColor={displayIconColor}
                      backgroundColor={displayIconBackground}
                      agentName={displayName}
                      size={48}
                    />
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {displayName}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        Custom AI Agent
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {version_created && (
                      <Badge variant="outline" className="text-xs">
                        <History className="w-3 h-3 mr-1" />
                        v{agent.version_count}
                      </Badge>
                    )}
                    {is_default && (
                      <Badge variant="outline" className="text-xs">
                        <Sparkles className="w-3 h-3 mr-1" />
                        Default
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800">
                      Active
                    </Badge>
                  </div>
                </div>

                {description && (
                  <div>
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-2">Description</h4>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                      {description}
                    </p>
                  </div>
                )}

                {updated_fields && updated_fields.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                        <Edit3 className="w-4 h-4" />
                        Updated Fields
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {updated_fields.map((field, index) => (
                          <Badge key={index} variant="outline" className="text-xs">
                            {formatFieldName(field)}
                          </Badge>
                        ))}
                      </div>
                      {version_created && (
                        <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-2">
                          <div className="flex items-center gap-1">
                            <History className="w-3 h-3" />
                            New version created (Version {agent.version_count})
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                <Separator />

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                      <Calendar className="w-3 h-3" />
                      <span>Created</span>
                    </div>
                    <p className="text-zinc-700 dark:text-zinc-300 pl-5">
                      {new Date(agent.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                      <RefreshCw className="w-3 h-3" />
                      <span>Updated</span>
                    </div>
                    <p className="text-zinc-700 dark:text-zinc-300 pl-5">
                      {new Date(agent.updated_at).toLocaleDateString()} at{' '}
                      {new Date(agent.updated_at).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              </div>

              {system_prompt && (
                <div className="border rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <User className="w-4 h-4" />
                    System Prompt Preview
                  </h4>
                  <div className="bg-muted/50 rounded-lg p-3 text-xs text-zinc-600 dark:text-zinc-400 font-mono max-h-32 overflow-y-auto">
                    {system_prompt.substring(0, 200)}
                    {system_prompt.length > 200 && '...'}
                  </div>
                </div>
              )}

              {agentpress_tools && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Tool Configuration
                    </h4>
                    <Badge variant="outline" className="text-xs">
                      {getEnabledToolsCount()} enabled
                    </Badge>
                  </div>
                  <div className="text-xs text-zinc-600 dark:text-zinc-400">
                    Agent has access to {getEnabledToolsCount()} tools out of {Object.keys(agentpress_tools).length} available tools
                  </div>
                </div>
              )}

              {message && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <p className="text-sm text-blue-800 dark:text-blue-200 flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    {message}
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to update agent. Please try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
