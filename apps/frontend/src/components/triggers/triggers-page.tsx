"use client";

import React, { useMemo, useState, useEffect } from 'react';
import { useAllTriggers, type TriggerWithAgent } from '@/hooks/triggers/use-all-triggers';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useRouter, useSearchParams } from 'next/navigation';
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
  Repeat,
  Search
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
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
  // Removed: schedules under 1 hour are no longer allowed
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
    <SpotlightCard
      className={cn(
        "transition-colors cursor-pointer",
        isSelected ? "bg-muted" : "bg-card"
      )}
    >
      <div
        onClick={onClick}
        className="flex items-center justify-between p-5"
      >
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-card border border-border/50 shrink-0">
            <Icon className="h-5 w-5 text-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-medium text-foreground truncate">{trigger.name}</h3>
              <Badge
                variant={trigger.is_active ? "highlight" : "secondary"}
                className="text-xs"
              >
                {trigger.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
            {trigger.description && (
              <p className="text-sm text-muted-foreground truncate">
                {trigger.description}
              </p>
            )}
          </div>
        </div>
        {isScheduled && trigger.config?.cron_expression && (
          <div className="ml-4 text-xs text-muted-foreground hidden sm:block">
            {formatCronExpression(trigger.config.cron_expression)}
          </div>
        )}
      </div>
    </SpotlightCard>
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
  <div className="space-y-4">
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
  const searchParams = useSearchParams();
  const router = useRouter();

  const sortedTriggers = useMemo(() => {
    return [...triggers].sort((a, b) => {
      if (a.is_active !== b.is_active) {
        return a.is_active ? -1 : 1;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [triggers]);

  // Handle trigger_id from URL
  useEffect(() => {
    const triggerIdFromUrl = searchParams.get('trigger_id');
    if (triggerIdFromUrl && triggers.length > 0) {
      const trigger = triggers.find(t => t.trigger_id === triggerIdFromUrl);
      if (trigger) {
        setSelectedTrigger(trigger);
        // Scroll to header
        setTimeout(() => {
          const headerHeight = document.querySelector('.container')?.clientHeight || 120;
          window.scrollTo({ top: headerHeight, behavior: 'smooth' });
        }, 100);
      }
    }
  }, [searchParams, triggers]);

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

  const handleTriggerClick = (trigger: TriggerWithAgent) => {
    if (selectedTrigger?.trigger_id === trigger.trigger_id) {
      setSelectedTrigger(null);
      // Remove trigger_id from URL
      router.replace('/triggers', { scroll: false });
    } else {
      setSelectedTrigger(trigger);
      // Add trigger_id to URL
      router.replace(`/triggers?trigger_id=${trigger.trigger_id}`, { scroll: false });
      const headerHeight = document.querySelector('.container')?.clientHeight || 120;
      window.scrollTo({ top: headerHeight, behavior: 'smooth' }); //for smooth brain
    }
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
      <div className="h-screen 2xl:flex overflow-hidden">
        {/* Backdrop overlay - shows when sidebar is open on screens < 2xl (1536px) */}
        {selectedTrigger && (
          <div
            className="block 2xl:hidden fixed inset-0 bg-black/70 z-30"
            onClick={handleClosePanel}
          />
        )}

        {/* Main Content - Lower z-index so sidebar overlays it */}
        <div className="h-full flex flex-col overflow-hidden 2xl:flex-1 relative z-0">
          {/* Search Bar and Create Button */}
          <div className="container mx-auto max-w-7xl px-4">
            <div className="flex items-center justify-between pb-4 pt-3">
              <div className="max-w-md w-md">
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Search"
                    className="h-10 w-full rounded-xl border border-input bg-background px-10 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  />
                  <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    <Search className="h-4 w-4" />
                  </div>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-10 px-4 rounded-xl gap-2"
                  >
                    <Plus className="h-4 w-4" />
                    Create new
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

          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent">
            <div className="container mx-auto max-w-7xl px-4 pb-8">
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
                      onClick={() => handleTriggerClick(trigger)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Sidebar Panel - Fixed overlay until 2XL breakpoint (1536px) */}
        <div className={cn(
          "h-screen transition-all duration-300 ease-in-out bg-background",
          // Fixed overlay on < 2xl screens, relative positioning on 2xl+
          "fixed 2xl:relative top-0 right-0",
          // Z-index: high on mobile/tablet/desktop, auto on 2xl+
          "z-40 2xl:z-auto",
          // Overflow handling - allow scrolling when open, hide when closed
          selectedTrigger ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden",
          // Border
          selectedTrigger && "border-l",
          // Aggressive width breakpoints - wider for better content display
          selectedTrigger
            ? "w-full min-[400px]:w-[90vw] min-[500px]:w-[85vw] sm:w-[480px] md:w-[540px] lg:w-[600px] xl:w-[640px] 2xl:w-[580px]"
            : "w-0 border-none"
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