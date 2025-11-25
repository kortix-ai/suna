import React from 'react';
import {
  Zap,
  CheckCircle,
  AlertTriangle,
  Bell,
  Settings,
  FileText,
  Activity,
  Play,
  Link2,
  Bot,
  Code2
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractCreateEventTriggerData } from './_utils';

export function CreateEventTriggerToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // Defensive check - ensure toolCall is defined
  if (!toolCall) {
    console.warn('CreateEventTriggerToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  const {
    slug,
    profile_id,
    connected_account_id,
    trigger_config,
    name: triggerName,
    agent_prompt,
    message,
    trigger,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCreateEventTriggerData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const formatSlugName = (slug: string): string => {
    return slug
      .replace(/_/g, ' ')
      .split(' ')
      .map(word => word.charAt(0) + word.slice(1).toLowerCase())
      .join(' ');
  };

  const formatConfigKey = (key: string): string => {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .trim();
  };

  const formatConfigValue = (value: any): string => {
    if (typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20">
              <Zap className="w-5 h-5 text-purple-500 dark:text-purple-400" />
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
              {actualIsSuccess ? 'Trigger created' : 'Creation failed'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Zap}
            iconColor="text-purple-500 dark:text-purple-400"
            bgColor="bg-gradient-to-b from-purple-100 to-purple-50 shadow-inner dark:from-purple-800/40 dark:to-purple-900/60 dark:shadow-purple-950/20"
            title="Creating event trigger"
            filePath={triggerName ? `"${triggerName}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && trigger ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-100 to-purple-50 dark:from-purple-900/40 dark:to-purple-800/20 border border-purple-200 dark:border-purple-800 flex items-center justify-center">
                      <Bell className="w-6 h-6 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg text-zinc-900 dark:text-zinc-100">
                        {triggerName || 'Event Trigger'}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {slug ? formatSlugName(slug) : 'Custom Event'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={trigger.is_active ? "default" : "secondary"}
                      className={cn(
                        "text-xs",
                        trigger.is_active 
                          ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800"
                          : "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-900/20 dark:text-gray-300 dark:border-gray-800"
                      )}
                    >
                      {trigger.is_active ? (
                        <>
                          <Activity className="h-3 w-3 mr-1" />
                          Active
                        </>
                      ) : 'Inactive'}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      <Link2 className="h-3 w-3 mr-1" />
                      {trigger.provider || 'Provider'}
                    </Badge>
                  </div>
                </div>

                {message && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      {message}
                    </p>
                  </div>
                )}

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                      <Zap className="w-3 h-3" />
                      <span className="text-xs">Trigger Type</span>
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 pl-5">
                      {trigger.slug || slug || 'Event Trigger'}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                      <Play className="w-3 h-3" />
                      <span className="text-xs">Status</span>
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 pl-5">
                      {trigger.is_active ? 'Running' : 'Stopped'}
                    </p>
                  </div>
                </div>
              </div>

              {trigger_config && Object.keys(trigger_config).length > 0 && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Settings className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                    <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Trigger Configuration
                    </h4>
                  </div>
                  <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 space-y-2">
                    {Object.entries(trigger_config).map(([key, value]) => (
                      <div key={key} className="flex items-start gap-2">
                        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 min-w-[120px]">
                          {formatConfigKey(key)}:
                        </span>
                        <span className="text-sm text-zinc-600 dark:text-zinc-400 font-mono break-all">
                          {formatConfigValue(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {agent_prompt && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                    <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Agent Execution Prompt
                    </h4>
                  </div>
                  <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3">
                    <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                      {agent_prompt}
                    </p>
                  </div>
                </div>
              )}

              {(connected_account_id || profile_id) && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                    <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Connection Details
                    </h4>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    {connected_account_id && (
                      <div className="space-y-1">
                        <span className="text-zinc-500 dark:text-zinc-400">Account ID</span>
                        <p className="font-mono text-zinc-700 dark:text-zinc-300">
                          {connected_account_id}
                        </p>
                      </div>
                    )}
                    {profile_id && (
                      <div className="space-y-1">
                        <span className="text-zinc-500 dark:text-zinc-400">Profile ID</span>
                        <p className="font-mono text-zinc-700 dark:text-zinc-300">
                          {profile_id}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="bg-gradient-to-r from-purple-50 to-blue-50 dark:from-purple-900/20 dark:to-blue-900/20 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
                <div className="flex items-center gap-2 text-sm text-purple-700 dark:text-purple-400">
                  <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" />
                  This trigger is now active and will automatically execute the agent when the configured event occurs.
                </div>
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to create event trigger. Please check your configuration and try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
