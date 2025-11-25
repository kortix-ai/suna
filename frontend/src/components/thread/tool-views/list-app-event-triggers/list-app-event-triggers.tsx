import React from 'react';
import {
  Bell,
  CheckCircle,
  AlertTriangle,
  Zap,
  Clock,
  Settings,
  FileText,
  Package,
  Info,
  Code2,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { ToolViewProps } from '../types';
import { formatTimestamp, getToolTitle } from '../utils';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from "@/components/ui/scroll-area";
import { LoadingState } from '../shared/LoadingState';
import { Separator } from "@/components/ui/separator";
import { extractListAppEventTriggersData, EventTrigger } from './_utils';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function ListAppEventTriggersToolView({
  toolCall,
  toolResult,
  assistantTimestamp,
  toolTimestamp,
  isSuccess = true,
  isStreaming = false,
}: ToolViewProps) {
  // All hooks must be called unconditionally at the top
  const [expandedTriggers, setExpandedTriggers] = React.useState<Set<string>>(new Set());

  // Defensive check - ensure toolCall is defined
  if (!toolCall) {
    console.warn('ListAppEventTriggersToolView: toolCall is undefined. Tool views should use structured props.');
    return null;
  }

  const name = toolCall.function_name.replace(/_/g, '-').toLowerCase();
  const toolTitle = getToolTitle(name);

  const {
    toolkit_slug,
    message,
    items,
    toolkit,
    total,
    actualIsSuccess,
    actualToolTimestamp,
    actualAssistantTimestamp
  } = extractListAppEventTriggersData(
    toolCall,
    toolResult,
    isSuccess,
    toolTimestamp,
    assistantTimestamp
  );

  const toggleTrigger = (slug: string) => {
    setExpandedTriggers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(slug)) {
        newSet.delete(slug);
      } else {
        newSet.add(slug);
      }
      return newSet;
    });
  };

  const getTriggerTypeIcon = (type: string) => {
    switch (type.toLowerCase()) {
      case 'poll':
        return <Clock className="w-3 h-3" />;
      case 'webhook':
        return <Zap className="w-3 h-3" />;
      default:
        return <Bell className="w-3 h-3" />;
    }
  };

  const getTriggerTypeBadgeVariant = (type: string) => {
    switch (type.toLowerCase()) {
      case 'poll':
        return "secondary";
      case 'webhook':
        return "default";
      default:
        return "outline";
    }
  };

  const formatPropertyName = (key: string): string => {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
      .trim();
  };

  return (
    <Card className="gap-0 flex border shadow-none border-t border-b-0 border-x-0 p-0 rounded-none flex-col h-full overflow-hidden bg-card">
      <CardHeader className="h-14 bg-zinc-50/80 dark:bg-zinc-900/80 backdrop-blur-sm border-b p-2 px-4 space-y-2">
        <div className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative p-2 rounded-xl bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20">
              <Bell className="w-5 h-5 text-orange-500 dark:text-orange-400" />
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
              {actualIsSuccess ? 'Triggers loaded' : 'Failed to load'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0 h-full flex-1 overflow-hidden relative">
        {isStreaming ? (
          <LoadingState
            icon={Bell}
            iconColor="text-orange-500 dark:text-orange-400"
            bgColor="bg-gradient-to-b from-orange-100 to-orange-50 shadow-inner dark:from-orange-800/40 dark:to-orange-900/60 dark:shadow-orange-950/20"
            title="Loading event triggers"
            showProgress={true}
          />
        ) : actualIsSuccess && toolkit ? (
          <ScrollArea className="h-full w-full">
            <div className="p-4 space-y-4">
              <div className="border rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    {toolkit.logo && (
                      <img 
                        src={toolkit.logo} 
                        alt={toolkit.name}
                        className="w-12 h-12 rounded-lg object-cover border border-zinc-200 dark:border-zinc-700"
                      />
                    )}
                    <div>
                      <h3 className="font-semibold text-lg text-zinc-900 dark:text-zinc-100">
                        {toolkit.name} Event Triggers
                      </h3>
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">
                        {message || `${total} trigger${total !== 1 ? 's' : ''} available`}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    <Package className="w-3 h-3 mr-1" />
                    {toolkit_slug}
                  </Badge>
                </div>
              </div>

              {items.length > 0 ? (
                <div className="space-y-3">
                  {items.map((trigger, index) => (
                    <Collapsible 
                      key={trigger.slug || index}
                      open={expandedTriggers.has(trigger.slug)}
                    >
                      <div className="border rounded-xl overflow-hidden">
                        <CollapsibleTrigger
                          onClick={() => toggleTrigger(trigger.slug)}
                          className="w-full p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex items-start gap-3 text-left">
                              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-900/40 dark:to-orange-800/20 border border-orange-200 dark:border-orange-800 flex items-center justify-center">
                                <Zap className="w-5 h-5 text-orange-600 dark:text-orange-400" />
                              </div>
                              <div className="space-y-1">
                                <h4 className="font-medium text-zinc-900 dark:text-zinc-100">
                                  {trigger.name}
                                </h4>
                                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                                  {trigger.description}
                                </p>
                                <div className="flex items-center gap-2 mt-2">
                                  <Badge 
                                    variant={getTriggerTypeBadgeVariant(trigger.type)} 
                                    className="text-xs"
                                  >
                                    {getTriggerTypeIcon(trigger.type)}
                                    <span className="ml-1">{trigger.type}</span>
                                  </Badge>
                                  <Badge variant="outline" className="text-xs">
                                    {trigger.slug}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center">
                              {expandedTriggers.has(trigger.slug) ? (
                                <ChevronUp className="w-4 h-4 text-zinc-400" />
                              ) : (
                                <ChevronDown className="w-4 h-4 text-zinc-400" />
                              )}
                            </div>
                          </div>
                        </CollapsibleTrigger>
                        
                        <CollapsibleContent>
                          <div className="px-4 pb-4 space-y-4 border-t">
                            {trigger.instructions && (
                              <div className="mt-4 space-y-2">
                                <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                  <Info className="w-4 h-4" />
                                  Instructions
                                </div>
                                <div className="text-sm text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3">
                                  {trigger.instructions.trim()}
                                </div>
                              </div>
                            )}

                            {trigger.config && trigger.config.properties && Object.keys(trigger.config.properties).length > 0 && (
                              <div className="space-y-2">
                                <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                  <Settings className="w-4 h-4" />
                                  Configuration Parameters
                                </div>
                                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 space-y-2">
                                  {Object.entries(trigger.config.properties).map(([key, prop]: [string, any]) => (
                                    <div key={key} className="space-y-1">
                                      <div className="flex items-center gap-2">
                                        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                                          {formatPropertyName(key)}
                                        </span>
                                        {prop.default !== undefined && (
                                          <Badge variant="secondary" className="text-xs">
                                            Default: {String(prop.default)}
                                          </Badge>
                                        )}
                                      </div>
                                      {prop.description && (
                                        <p className="text-xs text-zinc-600 dark:text-zinc-400 pl-2">
                                          {prop.description}
                                        </p>
                                      )}
                                      {prop.examples && prop.examples.length > 0 && (
                                        <div className="text-xs text-zinc-500 dark:text-zinc-500 pl-2">
                                          Examples: {prop.examples.join(', ')}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {trigger.payload && trigger.payload.properties && Object.keys(trigger.payload.properties).length > 0 && (
                              <div className="space-y-2">
                                <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                                  <Code2 className="w-4 h-4" />
                                  Payload Structure
                                </div>
                                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 space-y-2">
                                  {Object.entries(trigger.payload.properties).map(([key, prop]: [string, any]) => (
                                    <div key={key} className="flex items-center justify-between">
                                      <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300">
                                        {key}
                                      </span>
                                      <Badge variant="outline" className="text-xs">
                                        {prop.type || 'any'}
                                      </Badge>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </CollapsibleContent>
                      </div>
                    </Collapsible>
                  ))}
                </div>
              ) : (
                <div className="border rounded-xl p-6 text-center">
                  <Bell className="w-12 h-12 mx-auto text-zinc-400 dark:text-zinc-600 mb-3" />
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    No event triggers found for {toolkit?.name || 'this toolkit'}
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg m-4">
            <p className="text-sm text-red-800 dark:text-red-200 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Failed to load event triggers. Please try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
