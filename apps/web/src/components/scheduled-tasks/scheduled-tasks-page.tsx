"use client";

import React, { useMemo, useState } from 'react';
import { useTriggers, useDeleteTrigger, type Trigger } from '@/hooks/scheduled-tasks';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar, FilterBarItem } from '@/components/ui/tabs';
import { PageSearchBar } from '@/components/ui/page-search-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  AlertCircle,
  Calendar,
  Plus,
  Search,
  Clock,
  CheckCircle2,
  Timer,
  Trash2,
  Webhook,
  MessageSquare,
  Terminal,
  Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { PageHeader } from '@/components/ui/page-header';
import { TaskConfigDialog } from './task-config-dialog';
import { TaskDetailPanel } from './task-detail-panel';
import { toast } from 'sonner';

// ─── Helpers ────────────────────────────────────────────────────────────────

function describeCron(expr: string): string {
  try {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 6) return expr;

    const [sec, min, hour, day, month, weekday] = parts;

    if (sec.startsWith('*/') && min === '*' && hour === '*') {
      return `Every ${sec.slice(2)} seconds`;
    }
    if (sec === '0' && min.startsWith('*/') && hour === '*') {
      const n = min.slice(2);
      return `Every ${n} minute${n === '1' ? '' : 's'}`;
    }
    if (sec === '0' && min === '0' && hour.startsWith('*/')) {
      const n = hour.slice(2);
      return `Every ${n} hour${n === '1' ? '' : 's'}`;
    }
    if (
      sec === '0' &&
      !min.includes('*') &&
      !hour.includes('*') &&
      day === '*' &&
      month === '*'
    ) {
      const weekdayLabels: Record<string, string> = {
        '*': '',
        '1-5': ' (weekdays)',
        '0-6': '',
        '1': ' (Monday)',
        '2': ' (Tuesday)',
        '3': ' (Wednesday)',
        '4': ' (Thursday)',
        '5': ' (Friday)',
        '6': ' (Saturday)',
        '0': ' (Sunday)',
        '7': ' (Sunday)',
      };
      const suffix = weekdayLabels[weekday] ?? '';
      if (weekday === '*') {
        return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      }
      return `At ${hour.padStart(2, '0')}:${min.padStart(2, '0')}${suffix}`;
    }
    if (sec === '0' && min === '0' && hour === '0' && !day.includes('*') && month === '*') {
      return `Monthly on day ${day}`;
    }

    return expr;
  } catch {
    return expr;
  }
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiff = Math.abs(diffMs);

  if (absDiff < 60_000) return diffMs > 0 ? 'in <1m' : '<1m ago';
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    return diffMs > 0 ? `in ${mins}m` : `${mins}m ago`;
  }
  if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    return diffMs > 0 ? `in ${hrs}h` : `${hrs}h ago`;
  }
  const days = Math.round(absDiff / 86_400_000);
  return diffMs > 0 ? `in ${days}d` : `${days}d ago`;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

const TaskListItem = ({
  trigger,
  onClick,
  isSelected,
  onDelete,
  isDeleting,
}: {
  trigger: Trigger;
  onClick: () => void;
  isSelected: boolean;
  onDelete: (e: React.MouseEvent) => void;
  isDeleting: boolean;
}) => {
  const actionType = trigger.action_type ?? 'prompt';
  const actionIcon = actionType === 'command' ? <Terminal className="h-3 w-3" /> : actionType === 'http' ? <Globe className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />;

  return (
    <SpotlightCard
      className={cn(
        "transition-colors cursor-pointer group",
        isSelected ? "bg-primary/[0.06]" : "bg-card"
      )}
    >
      <div onClick={onClick} className="flex items-center justify-between p-5">
        <div className="flex items-center gap-4 flex-1 min-w-0">
            <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-card border border-border/50 shrink-0">
              {trigger.type === 'cron' ? <Timer className="h-5 w-5 text-foreground" /> : <Webhook className="h-5 w-5 text-foreground" />}
            </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-medium text-foreground truncate">{trigger.name}</h3>
              <Badge variant={trigger.isActive ? "highlight" : "secondary"} className="text-xs">
                {trigger.isActive ? 'Active' : 'Paused'}
              </Badge>
              <Badge variant="outline" className="text-xs flex items-center gap-1">
                {actionIcon}
                <span className="capitalize">{actionType}</span>
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground truncate">
              {trigger.type === 'cron'
                ? `${describeCron(trigger.cronExpr || '')} · ${trigger.timezone}`
                : `POST ${trigger.webhook?.path || ''}`}
            </p>
          </div>
        </div>
        <div className="ml-4 flex items-center gap-3 shrink-0">
          <div className="flex-col items-end gap-1 hidden sm:flex">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                <span>{trigger.type === 'cron' ? `Next: ${trigger.isActive ? formatRelativeTime(trigger.nextRunAt) : '--'}` : 'On demand'}</span>
              </div>
            {trigger.lastRunAt && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                <span>Last: {formatRelativeTime(trigger.lastRunAt)}</span>
              </div>
            )}
          </div>
          <Button
            onClick={onDelete}
            disabled={isDeleting}
            variant="ghost"
            size="icon-sm"
            className={cn(
              "opacity-0 group-hover:opacity-100 focus:opacity-100 text-muted-foreground",
              isDeleting && "opacity-100"
            )}
            title="Delete trigger"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </SpotlightCard>
  );
};

const LoadingSkeleton = () => (
  <div className="space-y-4">
    {[1, 2, 3].map((i) => (
      <div key={i} className="rounded-2xl border dark:bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-12 w-12 rounded-2xl" />
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

// ─── Main Page ──────────────────────────────────────────────────────────────

export function ScheduledTasksPage() {
  const { data: triggers = [], isLoading, error } = useTriggers();
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'cron' | 'webhook'>('all');
  const deleteMutation = useDeleteTrigger();

  const panelOpen = !!selectedTrigger;

  const filteredTriggers = useMemo(() => {
    let filtered = [...triggers].sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    if (typeFilter !== 'all') {
      filtered = filtered.filter((t) => t.type === typeFilter);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.cronExpr ? describeCron(t.cronExpr).toLowerCase().includes(q) : false) ||
          (t.webhook?.path?.toLowerCase().includes(q) ?? false) ||
          t.prompt.toLowerCase().includes(q),
      );
    }

    return filtered;
  }, [triggers, searchQuery, typeFilter]);

  const handleTriggerClick = (trigger: Trigger) => {
    if (selectedTrigger?.id === trigger.id) {
      setSelectedTrigger(null);
    } else {
      setSelectedTrigger(trigger);
    }
  };

  const handleClosePanel = () => {
    setSelectedTrigger(null);
  };

  const handleTaskCreated = () => {
    setShowCreateDialog(false);
  };

  const handleDelete = async (e: React.MouseEvent, trigger: Trigger) => {
    e.stopPropagation();
    if (!trigger.id) return;
    if (!confirm(`Delete "${trigger.name}"? This cannot be undone.`)) return;
    try {
      await deleteMutation.mutateAsync(trigger.id);
      toast.success('Trigger deleted');
      if (selectedTrigger?.id === trigger.id) {
        setSelectedTrigger(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  // Keep selected trigger in sync with refetched data
  React.useEffect(() => {
    if (selectedTrigger) {
      const updated = triggers.find(
        (t) => t.id === selectedTrigger.id,
      );
      if (updated) {
        setSelectedTrigger(updated);
      } else {
        setSelectedTrigger(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggers, selectedTrigger?.id]);

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
    <div className="min-h-[100dvh]">
      {/* Hero / PageHeader — collapses when panel is open */}
      <div
        className={cn(
          "overflow-hidden transition-colors duration-500 ease-in-out",
          panelOpen
            ? "max-h-0 opacity-0 py-0"
            : "max-h-[300px] opacity-100 py-3 sm:py-4"
        )}
      >
        <div className="container mx-auto max-w-7xl px-3 sm:px-4">
          <PageHeader icon={Calendar}>
            <div className="space-y-2 sm:space-y-4">
              <div className="text-2xl sm:text-3xl md:text-4xl font-semibold tracking-tight">
                <span className="text-primary">Triggers</span>
              </div>
            </div>
          </PageHeader>
        </div>
      </div>

      <div className="h-[100dvh] 2xl:flex overflow-hidden">
        {/* Backdrop overlay */}
        {selectedTrigger && (
          <div
            className="block 2xl:hidden fixed inset-0 bg-background/80 z-30"
            onClick={handleClosePanel}
          />
        )}

        {/* Main Content */}
        <div className="h-full flex flex-col overflow-hidden 2xl:flex-1 relative z-0">
          {/* Search + Filter + Create */}
          <div className="container mx-auto max-w-7xl px-3 sm:px-4">
            <div className="flex items-center justify-between gap-2 sm:gap-4 pb-3 sm:pb-4 pt-2 sm:pt-3">
              <div className="flex-1 flex items-center gap-2">
                <PageSearchBar
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Search triggers..."
                  className="max-w-md"
                />
                <FilterBar className="hidden sm:inline-flex">
                  {(['all', 'cron', 'webhook'] as const).map((f) => (
                    <FilterBarItem
                      key={f}
                      value={f}
                      onClick={() => setTypeFilter(f)}
                      data-state={typeFilter === f ? 'active' : 'inactive'}
                      className="capitalize"
                    >
                      {f}
                    </FilterBarItem>
                  ))}
                </FilterBar>
              </div>
              <Button
                variant="default"
                size="default"
                onClick={() => setShowCreateDialog(true)}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden xs:inline">Add Trigger</span>
                <span className="xs:hidden">Add</span>
              </Button>
            </div>
          </div>

          {/* Task List */}
          <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-300 dark:scrollbar-thumb-zinc-700 scrollbar-track-transparent">
            <div className="container mx-auto max-w-7xl px-3 sm:px-4 pb-6 sm:pb-8">
              {isLoading ? (
                <LoadingSkeleton />
              ) : filteredTriggers.length === 0 ? (
                <EmptyState
                  icon={Calendar}
                  title="Create a trigger"
                  description="Automate with triggers. Schedule cron jobs, set up webhooks, run commands, or call HTTP endpoints — all from one place."
                  action={
                    <Button onClick={() => setShowCreateDialog(true)} size="sm">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Trigger
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-4">
                  {filteredTriggers.map((trigger) => (
                    <TaskListItem
                      key={trigger.triggerId}
                      trigger={trigger}
                      isSelected={selectedTrigger?.triggerId === trigger.triggerId}
                      onClick={() => handleTriggerClick(trigger)}
                      onDelete={(e) => handleDelete(e, trigger)}
                      isDeleting={deleteMutation.isPending}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Detail Panel */}
        <div
          className={cn(
            "h-screen transition-colors duration-300 ease-in-out bg-background",
            "fixed 2xl:relative top-0 right-0",
            "z-40 2xl:z-auto",
            selectedTrigger ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden",
            selectedTrigger && "border-l",
            selectedTrigger
              ? "w-full min-[400px]:w-[90vw] min-[500px]:w-[85vw] sm:w-[480px] md:w-[540px] lg:w-[600px] xl:w-[640px] 2xl:w-[580px]"
              : "w-0 border-none"
          )}
        >
          {selectedTrigger && (
            <TaskDetailPanel
              trigger={selectedTrigger}
              onClose={handleClosePanel}
            />
          )}
        </div>

        {/* Create Dialog */}
        <TaskConfigDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onCreated={handleTaskCreated}
        />
      </div>
    </div>
  );
}
