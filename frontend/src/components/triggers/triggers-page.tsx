"use client";

import React, { useMemo, useState, useEffect } from 'react';
import { useAllTriggers, type TriggerWithAgent } from '@/hooks/react-query/triggers/use-all-triggers';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  MessageSquare,
  Github,
  Slack,
  Clock,
  AlertCircle,
  Zap,
  Hash,
  Globe,
  Sparkles,
  Plus,
  ChevronDown,
  PlugZap,
  Webhook,
  Repeat
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { TriggerCreationDialog } from './trigger-creation-dialog';
import { SimplifiedTriggerDetailPanel } from './simplified-trigger-detail-panel';
import { TriggersPageHeader } from './triggers-page-header';

const getTriggerIcon = (triggerType: string) => {
  switch (triggerType.toLowerCase()) {
    case 'schedule':
    case 'scheduled':
      return Repeat;
    case 'telegram':
      return MessageSquare;
    case 'github':
      return Github;
    case 'slack':
      return Slack;
    case 'webhook':
      return Webhook;
    case 'discord':
      return Hash;
    case 'event':
      return Sparkles;
    default:
      return Globe;
  }
};

const getTriggerCategory = (triggerType: string): 'scheduled' | 'app' => {
  const scheduledTypes = ['schedule', 'scheduled'];
  return scheduledTypes.includes(triggerType.toLowerCase()) ? 'scheduled' : 'app';
};

const formatCronExpression = (cron?: string) => {
  if (!cron) return 'Not configured';

  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (minute === '0' && hour === '0' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Daily at midnight';
  }
  if (minute === '0' && hour === '*/1' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every hour';
  }
  if (minute === '*/15' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every 15 minutes';
  }
  if (minute === '*/30' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return 'Every 30 minutes';
  }
  if (minute === '0' && hour === '9' && dayOfMonth === '*' && month === '*' && dayOfWeek === '1-5') {
    return 'Weekdays at 9 AM';
  }
  if (minute === '0' && hour === String(hour) && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Daily at ${hour}:${minute.padStart(2, '0')}`;
  }

  return cron;
};

const TriggerListItem = ({
  trigger,
  onClick,
  isSelected
}: {
  trigger: TriggerWithAgent;
  onClick: () => void;
  isSelected: boolean;
}) => {
  const Icon = getTriggerIcon(trigger.trigger_type);
  const isScheduled = getTriggerCategory(trigger.trigger_type) === 'scheduled';

  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-xl border group flex items-center justify-between px-4 py-3 cursor-pointer transition-all",
        isSelected ? "bg-muted border-foreground/20" : "dark:bg-card hover:bg-muted/50"
      )}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">{trigger.name}</span>
            <Badge
              variant={trigger.is_active ? "highlight" : "secondary"}
              className="text-xs"
            >
              {trigger.is_active ? "Active" : "Inactive"}
            </Badge>
          </div>
          {trigger.description && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {trigger.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {isScheduled && trigger.config?.cron_expression && (
          <span className="hidden sm:block">{formatCronExpression(trigger.config.cron_expression)}</span>
        )}
        <Repeat className="h-3 w-3" />
      </div>
    </div>
  );
};

const EmptyState = () => (
  <div className="bg-muted/20 rounded-3xl border flex flex-col items-center justify-center py-16 px-4">
    <div className="w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4">
      <Zap className="h-6 w-6 text-muted-foreground" />
    </div>
    <h3 className="text-base font-semibold text-foreground mb-2">Get started by adding a trigger</h3>
    <p className="text-sm text-muted-foreground text-center max-w-sm mb-6">
      Schedule a trigger to automate actions and get reminders when they complete.
    </p>
  </div>
);

const LoadingSkeleton = () => (
  <div className="space-y-4 px-4">
    {[1, 2, 3, 4, 5].map((i) => (
      <div key={i} className="rounded-xl border dark:bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    ))}
  </div>
);

export function TriggersPage() {
  const { data: triggers = [], isLoading, error } = useAllTriggers();
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerWithAgent | null>(null);
  const [triggerDialogType, setTriggerDialogType] = useState<'schedule' | 'event' | null>(null);
  const [pendingTriggerId, setPendingTriggerId] = useState<string | null>(null);

  const sortedTriggers = useMemo(() => {
    return [...triggers].sort((a, b) => {
      if (a.is_active !== b.is_active) {
        return a.is_active ? -1 : 1;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [triggers]);

  useEffect(() => {
    if (pendingTriggerId) {
      const newTrigger = triggers.find(t => t.trigger_id === pendingTriggerId);
      if (newTrigger) {
        setSelectedTrigger(newTrigger);
        setPendingTriggerId(null);
      }
    }
  }, [triggers, pendingTriggerId]);

  useEffect(() => {
    if (selectedTrigger) {
      const updatedTrigger = triggers.find(t => t.trigger_id === selectedTrigger.trigger_id);
      if (updatedTrigger) {
        setSelectedTrigger(updatedTrigger);
      } else {
        setSelectedTrigger(null);
      }
    }
  }, [triggers, selectedTrigger?.trigger_id]);

  const handleClosePanel = () => {
    setSelectedTrigger(null);
  };

  const handleTriggerCreated = (triggerId: string) => {
    setTriggerDialogType(null);
    setPendingTriggerId(triggerId);
  };

  if (error) {
    return (
      <div className="h-screen flex flex-col">
        <div className="max-w-4xl mx-auto w-full py-8 px-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Failed to load triggers. Please try refreshing the page.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <TriggersPageHeader />
      </div>
      <div className="h-screen flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex justify-center">
            <div className={cn(
              "w-full px-4 transition-all duration-300 ease-in-out",
              selectedTrigger ? "max-w-2xl" : "max-w-4xl"
            )}>
              <div className="flex items-center justify-between py-10">
                <h1 className="text-xl font-semibold">Triggers</h1>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Plus className="h-4 w-4" />
                    New trigger
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuItem onClick={() => setTriggerDialogType('schedule')} className='rounded-lg'>
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <div className="flex flex-col">
                      <span>Scheduled Trigger</span>
                      <span className="text-xs text-muted-foreground">
                        Schedule a trigger to run at a specific time
                      </span>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTriggerDialogType('event')} className='rounded-lg'>
                    <PlugZap className="h-4 w-4 text-muted-foreground" />
                    <div className="flex flex-col">
                      <span>Event-based Trigger</span>
                      <span className="text-xs text-muted-foreground">
                        Make a trigger to run when an event occurs
                      </span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent">
          <div className="flex justify-center">
            <div className={cn(
              "w-full px-4 pb-8 transition-all duration-300 ease-in-out",
              selectedTrigger ? "max-w-2xl" : "max-w-4xl"
            )}>
              {isLoading ? (
                <LoadingSkeleton />
              ) : sortedTriggers.length === 0 ? (
                <EmptyState />
              ) : (
                <div className="space-y-4">
                  {sortedTriggers.map(trigger => (
                    <TriggerListItem
                      key={trigger.trigger_id}
                      trigger={trigger}
                      isSelected={selectedTrigger?.trigger_id === trigger.trigger_id}
                      onClick={() => {
                        if (selectedTrigger?.trigger_id === trigger.trigger_id) {
                          setSelectedTrigger(null);
                        } else {
                          setSelectedTrigger(trigger);
                        }
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={cn(
        "h-screen transition-all duration-300 ease-in-out overflow-hidden border-l",
        selectedTrigger
          ? "w-full sm:w-[440px] xl:w-2xl"
          : "w-0"
      )}>
        {selectedTrigger && (
          <SimplifiedTriggerDetailPanel
            trigger={selectedTrigger}
            onClose={handleClosePanel}
          />
        )}
      </div>
        {/* Trigger Creation Dialog */}
        {triggerDialogType && (
          <TriggerCreationDialog
            open={!!triggerDialogType}
            onOpenChange={(open) => {
              if (!open) {
                setTriggerDialogType(null);
              }
            }}
            type={triggerDialogType}
            onTriggerCreated={handleTriggerCreated}
          />
        )}
      </div>
    </div>
  );
} 