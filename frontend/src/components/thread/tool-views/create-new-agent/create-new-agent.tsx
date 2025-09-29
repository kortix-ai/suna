import React from 'react';
import {
  Bot,
  CheckCircle,
  AlertTriangle,
  Calendar,
  Sparkles,
  User
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractCreateNewAgentData } from './_utils';
import { AgentAvatar } from '../../content/agent-avatar';


export function CreateNewAgentToolView({
  name = 'create-new-agent',
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
    agent_id,
    agent_name,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCreateNewAgentData(
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

  const getEnabledToolsList = () => {
    if (!agentpress_tools) return [];
    return Object.entries(agentpress_tools)
      .filter(([, enabled]) => enabled)
      .map(([tool]) => tool);
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Bot className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Agent created' : 'Creation failed'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Bot}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Creating agent"
            filePath={agentName ? `"${agentName}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && agentName ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <AgentAvatar
                      iconName={icon_name}
                      iconColor={icon_color}
                      backgroundColor={icon_background}
                      agentName={agentName}
                      size={48}
                    />
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {agentName}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        Custom AI Agent
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
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
                <Separator />
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
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to create agent. Please try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}