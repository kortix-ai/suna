import React from 'react';
import {
  Settings,
  CheckCircle,
  AlertTriangle,
  Zap,
  Package,
  User,
  Shield,
  Link2,
  Globe,
  Bot,
  Wrench
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractConfigureAgentIntegrationData } from './_utils';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';

export function ConfigureAgentIntegrationToolView({
  name = 'configure-agent-integration',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    agent_id,
    profile_name,
    enabled_tools,
    display_name,
    integration_name,
    enabled_tools_count,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractConfigureAgentIntegrationData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const getToolkitSlug = (integrationName: string): string => {
    return integrationName?.toLowerCase().replace(/\s+/g, '') || '';
  };

  const { data: iconData } = useComposioToolkitIcon(getToolkitSlug(integration_name || ''), {
    enabled: !!integration_name
  });

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-teal-500/20 to-teal-600/10 border border-teal-500/20">
              <Settings className="w-5 h-5 text-teal-500 dark:text-teal-400" />
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
              {actualIsSuccess ? 'Integration configured' : 'Configuration failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Settings}
            iconColor="text-teal-500 dark:text-teal-400"
            bgColor="bg-gradient-to-b from-teal-100 to-teal-50 shadow-inner dark:from-teal-800/40 dark:to-teal-900/60 dark:shadow-teal-950/20"
            title="Configuring integration"
            filePath={integration_name ? `"${integration_name}"` : undefined}
            showProgress={true}
          />
        ) : actualIsSuccess && integration_name ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-muted/50 border flex items-center justify-center overflow-hidden">
                      {iconData?.icon_url ? (
                        <img
                          src={iconData.icon_url}
                          alt={`${integration_name} logo`}
                          className="w-8 h-8 object-cover rounded"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent) {
                              parent.innerHTML = `<div class="w-full h-full flex items-center justify-center"><svg class="w-6 h-6 text-teal-600 dark:text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></div>`;
                            }
                          }}
                        />
                      ) : (
                        <Settings className="w-6 h-6 text-teal-600 dark:text-teal-400" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {display_name || integration_name || 'Integration'}
                      </h3>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      <Globe className="w-3 h-3 mr-1" />
                      {integration_name}
                    </Badge>
                    <Badge variant="secondary" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800">
                      <Shield className="w-3 h-3 mr-1" />
                      Active
                    </Badge>
                  </div>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Wrench className="w-4 h-4" />
                      Tools Configuration
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>Enabled: {enabled_tools_count}</div>
                      <div>Status: Configured</div>
                    </div>
                  </div>
                </div>
              </div>

              {enabled_tools && enabled_tools.length > 0 && (
                <div className="border rounded-xl p-4 space-y-3">
                  <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                    <Zap className="w-4 h-4" />
                    Enabled Tools ({enabled_tools_count})
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {enabled_tools.map((tool) => (
                      <Badge key={tool} variant="outline" className="text-xs">
                        <Wrench className="w-3 h-3 mr-1" />
                        {tool}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to configure integration. Please check the profile and try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 