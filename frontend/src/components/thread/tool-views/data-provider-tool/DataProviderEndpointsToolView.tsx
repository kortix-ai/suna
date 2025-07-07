import React from 'react';
import {
  Database,
  CheckCircle,
  AlertTriangle,
  Loader2,
  Briefcase,
  Home,
  ShoppingBag,
  TrendingUp,
  Users,
  MessageCircle,
  Globe,
  ChevronRight
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { extractDataProviderEndpointsData } from './_utils';

const PROVIDER_CONFIG = {
  'linkedin': {
    name: 'LinkedIn Data Provider',
    icon: Users,
    color: 'from-blue-500 to-blue-600',
    bgColor: 'bg-blue-50 dark:bg-blue-900/20',
    textColor: 'text-blue-700 dark:text-blue-300'
  },
  'twitter': {
    name: 'Twitter Data Provider',
    icon: MessageCircle,
    color: 'from-sky-400 to-sky-500',
    bgColor: 'bg-sky-50 dark:bg-sky-900/20',
    textColor: 'text-sky-700 dark:text-sky-300'
  },
  'zillow': {
    name: 'Zillow Data Provider',
    icon: Home,
    color: 'from-emerald-500 to-emerald-600',
    bgColor: 'bg-emerald-50 dark:bg-emerald-900/20',
    textColor: 'text-emerald-700 dark:text-emerald-300'
  },
  'amazon': {
    name: 'Amazon Data Provider',
    icon: ShoppingBag,
    color: 'from-orange-500 to-orange-600',
    bgColor: 'bg-orange-50 dark:bg-orange-900/20',
    textColor: 'text-orange-700 dark:text-orange-300'
  },
  'yahoo_finance': {
    name: 'Yahoo Finance Data Provider',
    icon: TrendingUp,
    color: 'from-purple-500 to-purple-600',
    bgColor: 'bg-purple-50 dark:bg-purple-900/20',
    textColor: 'text-purple-700 dark:text-purple-300'
  },
  'active_jobs': {
    name: 'Active Jobs Data Provider',
    icon: Briefcase,
    color: 'from-indigo-500 to-indigo-600',
    bgColor: 'bg-indigo-50 dark:bg-indigo-900/20',
    textColor: 'text-indigo-700 dark:text-indigo-300'
  }
};

export function DataProviderEndpointsToolView({
  name = 'get-data-provider-endpoints',
  assistantContent,
  toolContent,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {

  const {
    serviceName,
    endpoints,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractDataProviderEndpointsData(
    assistantContent,
    toolContent,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const providerConfig = serviceName && PROVIDER_CONFIG[serviceName]
    ? PROVIDER_CONFIG[serviceName]
    : PROVIDER_CONFIG['linkedin'];
  const IconComponent = providerConfig.icon;

  const endpointCount = endpoints && typeof endpoints === 'object' ? Object.keys(endpoints).length : 0;

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20">
              <Globe className="w-5 h-5 text-blue-500 dark:text-blue-400" />
            </div>
            <div>
              <CardTitle className="text-base font-medium text-zinc-900 dark:text-zinc-100">
                Data Provider
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
                <CheckCircle className="h-3 w-3 mr-1" />
              ) : (
                <AlertTriangle className="h-3 w-3 mr-1" />
              )}
              {actualIsSuccess ? 'Loaded' : 'Failed'}
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <div className="flex flex-col items-center justify-center h-full py-8 px-6">
            <div className="text-center w-full max-w-xs">
              <div className="w-16 h-16 rounded-xl mx-auto mb-4 flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">
                <Loader2 className="h-8 w-8 animate-spin text-zinc-500 dark:text-zinc-400" />
              </div>
              <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-2">
                Loading provider...
              </h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Connecting to data source
              </p>
            </div>
          </div>
        ) : (
          <div className="p-4 space-y-6">
            <div className="flex items-center gap-4 p-4 bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-800">
              <div className={cn(
                "w-12 h-12 rounded-lg flex items-center justify-center shadow-sm border-2",
                `bg-gradient-to-br ${providerConfig.color}`,
                "border-white/20"
              )}>
                <IconComponent className="h-6 w-6 text-white drop-shadow-sm" />
              </div>

              <div className="flex-1">
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                  {providerConfig.name}
                </h3>
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {endpointCount > 0 ? `${endpointCount} endpoints loaded and ready` : 'Endpoints loaded and ready'}
                </p>
              </div>

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
                  <CheckCircle className="h-3 w-3 mr-1" />
                ) : (
                  <AlertTriangle className="h-3 w-3 mr-1" />
                )}
                {actualIsSuccess ? 'Connected' : 'Failed'}
              </Badge>
            </div>
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                <Database className="h-4 w-4" />
                <span>Provider Status</span>
                <ChevronRight className="h-3 w-3 text-zinc-400" />
              </div>
              <div className="grid gap-3">
                <div className="flex items-center justify-between p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Connection Status
                    </span>
                  </div>
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
                      <CheckCircle className="h-3 w-3 mr-1" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 mr-1" />
                    )}
                    {actualIsSuccess ? 'Active' : 'Inactive'}
                  </Badge>
                </div>

                <div className="flex items-center justify-between p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Endpoints Available
                    </span>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    {endpointCount > 0 ? `${endpointCount} endpoints` : 'Ready'}
                  </Badge>
                </div>

                <div className="flex items-center justify-between p-3 bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
                  <div className="flex items-center gap-3">
                    <div className="w-2 h-2 rounded-full bg-purple-500"></div>
                    <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      Data Provider
                    </span>
                  </div>
                  <span className="text-sm text-zinc-600 dark:text-zinc-400 font-mono">
                    {serviceName || 'linkedin'}
                  </span>
                </div>
              </div>
              {actualIsSuccess && (
                <div className="p-4 bg-emerald-50 dark:bg-emerald-900/10 rounded-lg border border-emerald-200 dark:border-emerald-800/50">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400/70" />
                    <span className="text-sm font-medium text-emerald-800 dark:text-emerald-300/70">
                      Provider Ready
                    </span>
                  </div>
                  <p className="text-xs text-emerald-700 dark:text-emerald-300/70">
                    Data provider endpoints have been loaded successfully and are ready to process requests.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>

      <div className="px-4 py-2 h-10 bg-zinc-50/50 dark:bg-zinc-900/50 backdrop-blur-sm border-t border-zinc-200 dark:border-zinc-800 flex justify-between items-center gap-4">
        <div className="h-full flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          {!isStreaming && (
            <Badge variant="outline" className="h-6 py-0.5 text-xs">
              <IconComponent className="h-3 w-3 mr-1" />
              {providerConfig.name.split(' ')[0]}
            </Badge>
          )}
        </div>

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          {actualToolTimestamp && !isStreaming
            ? formatTimestamp(actualToolTimestamp)
            : actualAssistantTimestamp
              ? formatTimestamp(actualAssistantTimestamp)
              : ''}
        </div>
      </div>
    </Card>
  );
} 