import React from 'react';
import {
  UserPlus,
  CheckCircle,
  AlertTriangle,
  User,
  Calendar,
  Settings,
  Link2,
  Link2Off,
  Clock,
  Badge as BadgeIcon,
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
import { extractCreateCredentialProfileData, CredentialProfile } from './_utils';

export function CreateCredentialProfileToolView({
  name = 'create-credential-profile',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    toolkit_slug,
    profile_name,
    display_name,
    message,
    profile,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractCreateCredentialProfileData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const logoUrl = undefined;

  const formatCreatedAt = (dateString: string) => {
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
        : 'bg-yellow-100 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800',
      text: isConnected ? 'Connected' : 'Not Connected'
    };
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20">
              <UserPlus className="w-5 h-5 text-green-500 dark:text-green-400" />
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
              {actualIsSuccess ? 'Profile created' : 'Creation failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={UserPlus}
            iconColor="text-green-500 dark:text-green-400"
            bgColor="bg-gradient-to-b from-green-100 to-green-50 shadow-inner dark:from-green-800/40 dark:to-green-900/60 dark:shadow-green-950/20"
            title="Creating credential profile"
            filePath={profile_name ? `"${profile_name}"` : undefined}
            showProgress={true}
          />
        ) : profile ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-muted/50 border flex items-center justify-center overflow-hidden">
                      {logoUrl ? (
                        <img
                          src={logoUrl}
                          alt={`${profile.toolkit_name} logo`}
                          className="w-8 h-8 object-cover rounded"
                          onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            const parent = target.parentElement;
                            if (parent) {
                              parent.innerHTML = `<div class="w-full h-full flex items-center justify-center"><svg class="w-6 h-6 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg></div>`;
                            }
                          }}
                        />
                      ) : (
                        <User className="w-6 h-6 text-green-600 dark:text-green-400" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">
                        {profile.display_name}
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {profile.toolkit_name}
                      </p>
                    </div>
                  </div>

                  {(() => {
                    const status = getConnectionStatus(profile.is_connected);
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                      <BadgeIcon className="w-4 h-4" />
                      <span>Profile Name</span>
                    </div>
                    <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 pl-6">
                      {profile.profile_name}
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
                      <Server className="w-4 h-4" /> 
                      <span>Toolkit Slug</span>
                    </div>
                    <p className="text-sm font-mono text-zinc-700 dark:text-zinc-300 pl-6">
                      {profile.toolkit_slug}
                    </p>
                  </div>
                </div>

                {!profile.is_connected && (
                  <div className="mt-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-3">
                    <div className="flex items-start gap-2">
                      <Settings className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-blue-900 dark:text-blue-100 mb-1">
                          Setup Required
                        </p>
                        <p className="text-xs text-blue-700 dark:text-blue-300">
                          This credential profile needs to be connected before it can be used. Follow the authentication flow to complete the setup.
                        </p>
                      </div>
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
                <UserPlus className="h-8 w-8 text-zinc-400" />
              </div>
              <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                Profile not created
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {toolkit_slug ? `Failed to create profile for "${toolkit_slug}"` : 'Credential profile creation failed'}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 