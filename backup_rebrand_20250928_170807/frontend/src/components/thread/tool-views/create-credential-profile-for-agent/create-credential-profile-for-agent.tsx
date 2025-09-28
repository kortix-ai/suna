import React, { useState } from 'react';
import {
  UserPlus,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Shield,
  ShieldCheck,
  Key,
  Link2,
  User,
  Clock,
  Globe,
  ArrowRight
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
import { extractCreateCredentialProfileData } from './_utils';
import { useComposioToolkitIcon } from '@/hooks/react-query/composio/use-composio';

export function CreateCredentialProfileForAgentToolView({
  name = 'create-credential-profile-for-agent',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const [authCompleted, setAuthCompleted] = useState(false);

  const {
    toolkit_slug,
    profile_name,
    authentication_url,
    toolkit_name,
    requires_authentication,
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
  const { data: iconData } = useComposioToolkitIcon(toolkit_slug || '', {
    enabled: !!toolkit_slug
  });

  const handleAuthClick = () => {
    if (authentication_url) {
      window.open(authentication_url, '_blank', 'noopener,noreferrer');
      setTimeout(() => setAuthCompleted(true), 1000);
    }
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
                      authCompleted 
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:border-emerald-800"
                        : "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-300 dark:border-yellow-800"
                    )}>
                      {authCompleted ? (
                        <ShieldCheck className="w-3 h-3 mr-1" />
                      ) : (
                        <Shield className="w-3 h-3 mr-1" />
                      )}
                      {authCompleted ? 'Authenticated' : 'Pending Auth'}
                    </Badge>
                  </div>
                </div>

                <Separator />

                {/* Profile Details */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Key className="w-4 h-4" />
                      Profile Details
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>Name: {profile_name}</div>
                      <div>Service: {toolkit_name || toolkit_slug}</div>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <h4 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                      <Shield className="w-4 h-4" />
                      Authentication
                    </h4>
                    <div className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                      <div>Required: {requires_authentication ? 'Yes' : 'No'}</div>
                      <div>Status: {authCompleted ? 'Complete' : 'Pending'}</div>
                    </div>
                  </div>
                </div>
              </div>
              {requires_authentication && authentication_url && !authCompleted && (
                <div className="border rounded-xl p-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <Key className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                    <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                      Authentication Required
                    </h4>
                  </div>
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    Complete the authentication process to activate this credential profile:
                  </p>
                  <Button 
                      onClick={handleAuthClick}
                      className="w-full"
                      size="sm"
                  >
                    Authenticate with {toolkit_name || toolkit_slug}
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to create credential profile. Please try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 