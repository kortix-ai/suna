import React from 'react';
import {
  CheckCircle,
  AlertTriangle,
  Shield,
  Link2,
  Link2Off,
  Wrench,
  User,
  Calendar,
  Activity,
  Hash,
  Zap,
  Server
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractCheckProfileConnectionData, Connection } from './_utils';

export function CheckProfileConnectionToolView({
  name = 'check-profile-connection',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    profile_name,
    app_name,
    app_slug,
    is_connected,
    connections,
    connection_count,
    available_tools,
    tool_count,
    message,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCheckProfileConnectionData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const formatConnectionTime = (dateString: string) => {
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

  const getConnectionStatus = (isConnected: boolean) => {
    return {
      icon: isConnected ? Link2 : Link2Off,
      color: isConnected 
        ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800'
        : 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800',
      text: isConnected ? 'Connected' : 'Not Connected'
    };
  };

  const formatToolName = (toolName: string) => {
    return toolName
      .replace(/^[A-Z_]+-/, '')
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20">
              <Shield className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />
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
              {actualIsSuccess ? 'Connection verified' : 'Verification failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Shield}
            iconColor="text-emerald-500 dark:text-emerald-400"
            bgColor="bg-gradient-to-b from-emerald-100 to-emerald-50 shadow-inner dark:from-emerald-800/40 dark:to-emerald-900/60 dark:shadow-emerald-950/20"
            title="Checking profile connection"
            filePath={profile_name ? `"${profile_name}"` : undefined}
            showProgress={true}
          />
        ) : profile_name ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-100 to-emerald-50 dark:from-emerald-900/40 dark:to-emerald-800/20 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center">
                      <User className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {profile_name}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {app_name}
                      </p>
                    </div>
                  </div>

                  {(() => {
                    const status = getConnectionStatus(is_connected);
                    const StatusIcon = status.icon;
                    return (
                      <Badge
                        variant="outline"
                        className={cn("text-xs font-medium", status.color)}
                      >
                        <StatusIcon className="w-3 h-3" />
                        {status.text}
                      </Badge>
                    );
                  })()}
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                      {connection_count}
                    </div>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      {connection_count === 1 ? 'Connection' : 'Connections'}
                    </p>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
                      {tool_count}
                    </div>
                    <p className="text-sm text-zinc-500 dark:text-zinc-400">
                      Available {tool_count === 1 ? 'Tool' : 'Tools'}
                    </p>
                  </div>
                </div>
              </div>

              {available_tools.length > 0 && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-blue-500" />
                    <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Available Tools
                    </h3>
                    <Badge variant="outline" className="text-xs">
                      {tool_count}
                    </Badge>
                  </div>
                  
                  <div className="space-y-2">
                    {available_tools.map((tool, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-xl"
                      >
                        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900/40 dark:to-blue-800/20 border border-blue-200 dark:border-blue-800 flex items-center justify-center">
                          <Zap className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div>
                          <p className="font-medium text-zinc-900 dark:text-zinc-100">
                            {formatToolName(tool)}
                          </p>
                          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                            {tool}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {connections.length > 0 && (
                <div className="border rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <Activity className="w-4 h-4 text-green-500" />
                    <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Active Connections
                    </h3>
                    <Badge variant="outline" className="text-xs">
                      {connection_count}
                    </Badge>
                  </div>
                  
                  <div className="space-y-2">
                    {connections.map((connection, index) => (
                      <div
                        key={index}
                        className="p-3 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-xl space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Server className="w-4 h-4 text-zinc-500" />
                            <span className="font-medium text-zinc-900 dark:text-zinc-100">
                              {connection.app_name}
                            </span>
                          </div>
                          
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-xs font-medium",
                              connection.is_active
                                ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/20 dark:text-green-300 dark:border-green-800"
                                : "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-900/20 dark:text-gray-300 dark:border-gray-800"
                            )}
                          >
                            {connection.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        
                        <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-1">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-3 h-3" />
                            <span>Connected: {formatConnectionTime(connection.created_at)}</span>
                          </div>
                          {connection.updated_at && connection.updated_at !== connection.created_at && (
                            <div className="flex items-center gap-2">
                              <Activity className="w-3 h-3" />
                              <span>Updated: {formatConnectionTime(connection.updated_at)}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {available_tools.length === 0 && is_connected && (
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl p-4 text-center">
                  <Wrench className="w-8 h-8 text-yellow-600 dark:text-yellow-400 mx-auto mb-2" />
                  <h3 className="font-medium text-yellow-900 dark:text-yellow-100 mb-1">
                    No Tools Available
                  </h3>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    This profile is connected but no tools are currently available for this integration.
                  </p>
                </div>
              )}

              {!is_connected && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 text-center">
                  <Link2Off className="w-8 h-8 text-red-600 dark:text-red-400 mx-auto mb-2" />
                  <h3 className="font-medium text-red-900 dark:text-red-100 mb-1">
                    Profile Not Connected
                  </h3>
                  <p className="text-sm text-red-700 dark:text-red-300">
                    This credential profile needs to be connected before tools become available.
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex flex-col items-center justify-center h-full py-8 px-6">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-xl mx-auto mb-4 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                <Shield className="h-8 w-8 text-zinc-400" />
              </div>
              <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                No profile information
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Unable to retrieve connection status for this profile
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 