import React, { useState, useEffect } from 'react';
import {
  Link2,
  CheckCircle,
  AlertTriangle,
  ExternalLink,
  Clock,
  Copy,
  Check,
  AlertCircle,
  User,
  Zap
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
import { extractConnectCredentialProfileData } from './_utils';

export function ConnectCredentialProfileToolView({
  name = 'connect-credential-profile',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const [copiedLink, setCopiedLink] = useState(false);
  const [timeUntilExpiry, setTimeUntilExpiry] = useState<string>('');

  const {
    profile_name,
    app_name,
    app_slug,
    connection_link,
    expires_at,
    instructions,
    message,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractConnectCredentialProfileData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toolTitle = getToolTitle(name);

  const logoUrl = undefined;

  // Update countdown timer
  useEffect(() => {
    if (!expires_at) return;

    const updateTimer = () => {
      try {
        const expiryTime = new Date(expires_at);
        const now = new Date();
        const timeDiff = expiryTime.getTime() - now.getTime();

        if (timeDiff <= 0) {
          setTimeUntilExpiry('Expired');
          return;
        }

        const hours = Math.floor(timeDiff / (1000 * 60 * 60));
        const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((timeDiff % (1000 * 60)) / 1000);

        if (hours > 0) {
          setTimeUntilExpiry(`${hours}h ${minutes}m`);
        } else if (minutes > 0) {
          setTimeUntilExpiry(`${minutes}m ${seconds}s`);
        } else {
          setTimeUntilExpiry(`${seconds}s`);
        }
      } catch (e) {
        setTimeUntilExpiry('');
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [expires_at]);

  const formatExpiryTime = (dateString: string) => {
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

  const copyLink = async () => {
    if (!connection_link) return;
    
    try {
      await navigator.clipboard.writeText(connection_link);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch (e) {
      console.error('Failed to copy link:', e);
    }
  };

  const openConnectionLink = () => {
    if (connection_link) {
      window.open(connection_link, '_blank', 'noopener,noreferrer');
    }
  };

  const isExpired = expires_at && new Date(expires_at) <= new Date();

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Link2 className="w-5 h-5 text-blue-500 dark:text-blue-400" />
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
              {actualIsSuccess ? 'Link generated' : 'Generation failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Link2}
            iconColor="text-blue-500 dark:text-blue-400"
            bgColor="bg-gradient-to-b from-blue-100 to-blue-50 shadow-inner dark:from-blue-800/40 dark:to-blue-900/60 dark:shadow-blue-950/20"
            title="Generating connection link"
            filePath={profile_name ? `"${profile_name}"` : undefined}
            showProgress={true}
          />
        ) : connection_link ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-100 to-blue-50 dark:from-blue-900/40 dark:to-blue-800/20 border border-blue-200 dark:border-blue-800 flex items-center justify-center overflow-hidden">
                    {logoUrl ? (
                      <img
                        src={logoUrl}
                        alt={`${app_name} logo`}
                        className="w-6 h-6 object-cover rounded"
                        onError={(e) => {
                          const target = e.target as HTMLImageElement;
                          target.style.display = 'none';
                          const parent = target.parentElement;
                          if (parent) {
                            parent.innerHTML = `<div class="w-full h-full flex items-center justify-center"><svg class="w-5 h-5 text-blue-600 dark:text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg></div>`;
                          }
                        }}
                      />
                    ) : (
                      <User className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                    )}
                  </div>
                  <div>
                    <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                      {profile_name}
                    </h3>
                    <p className="text-sm text-zinc-600 dark:text-zinc-400">
                      {app_name}
                    </p>
                  </div>
                </div>

                {instructions && (
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-3">
                    <div className="flex items-start gap-2">
                      <Zap className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
                      <p className="text-sm text-blue-700 dark:text-blue-300">
                        {instructions}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                    Connection Link
                  </h3>
                  
                  {expires_at && (
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-zinc-500" />
                      <span className={cn(
                        "text-xs font-medium",
                        isExpired 
                          ? "text-red-600 dark:text-red-400"
                          : timeUntilExpiry.includes('m') || timeUntilExpiry.includes('h')
                            ? "text-green-600 dark:text-green-400"
                            : "text-yellow-600 dark:text-yellow-400"
                      )}>
                        {isExpired ? 'Expired' : `Expires in ${timeUntilExpiry}`}
                      </span>
                    </div>
                  )}
                </div>

                <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
                  <p className="text-xs font-mono text-zinc-600 dark:text-zinc-400 mb-3 break-all">
                    {connection_link}
                  </p>
                  
                  <div className="flex gap-2">
                    <Button
                      onClick={openConnectionLink}
                      disabled={isExpired}
                      className={cn(
                        "flex-1 h-9",
                        isExpired && "opacity-50 cursor-not-allowed"
                      )}
                    >
                      <ExternalLink className="w-4 h-4" />
                      {isExpired ? 'Link Expired' : 'Connect Account'}
                    </Button>
                    
                    <Button
                      variant="outline"
                      onClick={copyLink}
                      disabled={isExpired}
                      className="h-9 px-3"
                    >
                      {copiedLink ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {expires_at && (
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" />
                    Link expires on {formatExpiryTime(expires_at)}
                  </div>
                )}

                {isExpired && (
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-red-900 dark:text-red-100 mb-1">
                          Connection Link Expired
                        </p>
                        <p className="text-xs text-red-700 dark:text-red-300">
                          This connection link has expired. You'll need to generate a new one to connect your account.
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
                <Link2 className="h-8 w-8 text-zinc-400" />
              </div>
              <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                No connection link generated
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {profile_name ? `Failed to generate link for "${profile_name}"` : 'Connection link generation failed'}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
} 