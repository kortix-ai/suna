'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Clock,
  X,
  Trash2,
  Edit2,
  Sparkles,
  Calendar as CalendarIcon,
  Timer,
  Target,
  Repeat,
  Play,
  Pause,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Loader2,
  History,
  Globe,
  ArrowRight
} from 'lucide-react';
import Link from 'next/link';
import { TriggerWithAgent } from '@/hooks/triggers/use-all-triggers';
import { useDeleteTrigger, useToggleTrigger, useUpdateTrigger } from '@/hooks/triggers';
import { useTriggerExecutions, type TriggerExecution } from '@/hooks/triggers/use-trigger-executions';
import { TriggerCreationDialog } from './trigger-creation-dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { formatDistanceToNow, format, parseISO } from 'date-fns';

interface SimplifiedTriggerDetailPanelProps {
  trigger: TriggerWithAgent;
  onClose: () => void;
}

const SCHEDULE_PRESETS = [
  { cron: '0 * * * *', name: 'Every hour', icon: <Timer className="h-4 w-4" /> },
  { cron: '0 9 * * *', name: 'Daily at 9 AM', icon: <Target className="h-4 w-4" /> },
  { cron: '0 9 * * 1-5', name: 'Weekdays at 9 AM', icon: <CalendarIcon className="h-4 w-4" /> },
  { cron: '0 9 * * 1', name: 'Weekly on Monday', icon: <Repeat className="h-4 w-4" /> },
  { cron: '0 9 1 * *', name: 'Monthly on 1st', icon: <CalendarIcon className="h-4 w-4" /> },
];

const getScheduleDisplay = (cron?: string) => {
  if (!cron) return { name: 'Not configured', icon: <Clock className="h-4 w-4" /> };

  const preset = SCHEDULE_PRESETS.find(p => p.cron === cron);
  if (preset) return preset;

  return { name: cron, icon: <Clock className="h-4 w-4" /> };
};

const getStatusIcon = (status: string) => {
  switch (status.toLowerCase()) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'failed':
    case 'error':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'running':
    case 'in_progress':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
};

const getStatusBadgeVariant = (status: string): "default" | "secondary" | "destructive" | "outline" | "highlight" => {
  switch (status.toLowerCase()) {
    case 'completed':
      return 'highlight';
    case 'failed':
    case 'error':
      return 'destructive';
    case 'running':
    case 'in_progress':
      return 'default';
    default:
      return 'secondary';
  }
};

const ExecutionItem = ({ execution }: { execution: TriggerExecution }) => {
  const startedAt = parseISO(execution.started_at);
  const timeAgo = formatDistanceToNow(startedAt, { addSuffix: true });
  const formattedTime = format(startedAt, 'MMM d, h:mm a');

  return (
    <Link
      href={`/threads/${execution.thread_id}`}
      className="block"
    >
      <div className="flex items-center justify-between p-3 rounded-2xl hover:bg-muted/50 transition-colors group">
        <div className="flex items-center gap-3">
          {getStatusIcon(execution.status)}
          <div>
            <div className="text-sm font-medium text-foreground group-hover:text-primary transition-colors">
              {formattedTime}
            </div>
            <div className="text-xs text-muted-foreground">
              {timeAgo}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={getStatusBadgeVariant(execution.status)} className="text-xs capitalize">
            {execution.status}
          </Badge>
          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>
    </Link>
  );
};

const ExecutionsSkeleton = () => (
  <div className="space-y-2">
    {[1, 2, 3].map((i) => (
      <div key={i} className="flex items-center justify-between p-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-4 rounded-full" />
          <div className="space-y-1">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
    ))}
  </div>
);

export function SimplifiedTriggerDetailPanel({ trigger, onClose }: SimplifiedTriggerDetailPanelProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const deleteMutation = useDeleteTrigger();
  const toggleMutation = useToggleTrigger();
  const updateMutation = useUpdateTrigger();

  // Fetch trigger execution history
  const { data: executionHistory, isLoading: isLoadingExecutions } = useTriggerExecutions(trigger.trigger_id);

  const isScheduled = trigger.trigger_type.toLowerCase() === 'schedule' || trigger.trigger_type.toLowerCase() === 'scheduled';
  const scheduleDisplay = getScheduleDisplay(trigger.config?.cron_expression);
  const timezone = trigger.config?.timezone || executionHistory?.timezone || 'UTC';

  const handleToggle = async () => {
    try {
      await toggleMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        isActive: !trigger.is_active,
      });
      toast.success(`Task ${!trigger.is_active ? 'enabled' : 'disabled'}`);
    } catch (error) {
      toast.error('Failed to toggle task');
      console.error('Error toggling task:', error);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        agentId: trigger.agent_id
      });
      toast.success('Task deleted successfully');
      onClose();
    } catch (error) {
      toast.error('Failed to delete task');
      console.error('Error deleting task:', error);
    }
  };

  const handleEditSave = async (config: any) => {
    try {
      await updateMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        name: config.name,
        description: config.description,
        config: config.config,
        is_active: config.is_active,
      });
      toast.success('Task updated successfully');
      setShowEditDialog(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to update task');
      console.error('Error updating task:', error);
    }
  };

  const isLoading = deleteMutation.isPending || toggleMutation.isPending || updateMutation.isPending;

  const triggerConfig = {
    trigger_id: trigger.trigger_id,
    agent_id: trigger.agent_id,
    trigger_type: trigger.trigger_type,
    provider_id: trigger.provider_id,
    name: trigger.name,
    description: trigger.description,
    is_active: trigger.is_active,
    webhook_url: trigger.webhook_url,
    created_at: trigger.created_at,
    updated_at: trigger.updated_at,
    config: trigger.config
  };

  // Format next run time
  const nextRunDisplay = executionHistory?.next_run_time_local
    ? format(parseISO(executionHistory.next_run_time_local), 'MMM d, h:mm a')
    : null;

  const nextRunTimeAgo = executionHistory?.next_run_time_local
    ? formatDistanceToNow(parseISO(executionHistory.next_run_time_local), { addSuffix: true })
    : null;

  return (
    <div className="h-full bg-background flex flex-col w-full">
      {/* Header */}
      <div className="px-6 py-6 border-b">
        <div className="flex items-start justify-between mb-6">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-medium text-foreground">{trigger.name}</h1>
              <Badge
                variant={trigger.is_active ? "highlight" : "secondary"}
                className="text-xs"
              >
                {trigger.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
            {trigger.description && (
              <p className="text-muted-foreground text-sm leading-relaxed">{trigger.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowEditDialog(true)}
              className="hover:bg-muted"
            >
              <Edit2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isLoading}
              className="hover:bg-destructive/10 hover:border-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:bg-muted"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="flex gap-3">
          <Button
            size="sm"
            variant={trigger.is_active ? "outline" : "default"}
            onClick={handleToggle}
            disabled={isLoading}
            className={cn(
              "flex-1",
              trigger.is_active
                ? "hover:bg-muted"
                : "bg-primary hover:bg-primary/90 text-primary-foreground"
            )}
          >
            {trigger.is_active ? (
              <>
                <Pause className="h-4 w-4 mr-2" />
                Disable
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Enable
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {/* Next Run - Only for scheduled triggers */}
        {isScheduled && trigger.is_active && nextRunDisplay && (
          <div className="border rounded-lg p-6 bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-primary/10">
                <Timer className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-foreground mb-1">Next Run</h3>
                <p className="text-lg font-semibold text-primary">{nextRunDisplay}</p>
                <p className="text-sm text-muted-foreground">{nextRunTimeAgo}</p>
              </div>
            </div>
          </div>
        )}

        {/* Schedule Info */}
        {isScheduled && (
          <div className="border rounded-lg p-6 bg-card">
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-muted">
                <Clock className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-foreground mb-1">Schedule</h3>
                <p className="text-sm text-muted-foreground">
                  {executionHistory?.human_readable_schedule || scheduleDisplay.name}
                </p>
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <Globe className="h-3 w-3" />
                  <span>{timezone}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Execution History */}
        <div className="border rounded-lg p-6 bg-card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-muted">
                <History className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <h3 className="font-medium text-foreground">Recent Runs</h3>
                <p className="text-xs text-muted-foreground">
                  {executionHistory?.total_count || 0} execution{(executionHistory?.total_count || 0) !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
          </div>

          {isLoadingExecutions ? (
            <ExecutionsSkeleton />
          ) : executionHistory?.executions && executionHistory.executions.length > 0 ? (
            <div className="space-y-1 -mx-3">
              {executionHistory.executions.slice(0, 5).map((execution) => (
                <ExecutionItem key={execution.execution_id} execution={execution} />
              ))}
              {executionHistory.executions.length > 5 && (
                <div className="text-center pt-2">
                  <span className="text-xs text-muted-foreground">
                    Showing 5 of {executionHistory.total_count} runs
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No executions yet</p>
              <p className="text-xs mt-1">Runs will appear here when the trigger fires</p>
            </div>
          )}
        </div>

        {/* Execution Details */}
        <div className="border rounded-lg p-6 bg-card">
          <div className="flex items-start gap-4 mb-4">
            <div className="p-2 rounded-lg bg-muted">
              <Sparkles className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-foreground mb-1">Agent Instructions</h3>
              <p className="text-sm text-muted-foreground">Custom prompt for the agent</p>
            </div>
          </div>

          {trigger.config.agent_prompt && (
            <div className="mt-4 p-4 rounded-lg bg-muted border">
              <p className="text-sm font-mono text-foreground whitespace-pre-wrap leading-relaxed">
                {trigger.config.agent_prompt}
              </p>
            </div>
          )}
        </div>

        {/* Agent Info */}
        <div className="border rounded-lg p-6 bg-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <AgentAvatar
                agentId={trigger.agent_id}
                size={40}
                fallbackName={trigger.agent_name}
              />
              <div>
                <h3 className="font-medium text-foreground">{trigger.agent_name || 'Unknown Agent'}</h3>
                <p className="text-sm text-muted-foreground">Assigned Agent</p>
              </div>
            </div>
            <Link
              href={`/agents/config/${trigger.agent_id}`}
              className="p-2 rounded-2xl hover:bg-muted transition-colors"
            >
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            </Link>
          </div>
        </div>

        {/* Technical Details */}
        <div className="border rounded-lg p-6 bg-card">
          <h3 className="font-medium text-foreground mb-4">Technical Details</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b last:border-b-0">
              <span className="text-sm text-muted-foreground">Type</span>
              <span className="text-sm font-mono text-foreground">{trigger.trigger_type}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b last:border-b-0">
              <span className="text-sm text-muted-foreground">Provider</span>
              <span className="text-sm font-mono text-foreground">{trigger.provider_id}</span>
            </div>
            {isScheduled && trigger.config?.cron_expression && (
              <div className="flex justify-between items-center py-2 border-b last:border-b-0">
                <span className="text-sm text-muted-foreground">Cron Expression</span>
                <span className="text-sm font-mono text-foreground">{trigger.config.cron_expression}</span>
              </div>
            )}
            <div className="flex justify-between items-center py-2 border-b last:border-b-0">
              <span className="text-sm text-muted-foreground">Created</span>
              <span className="text-sm text-foreground">{new Date(trigger.created_at).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-muted-foreground">Last Updated</span>
              <span className="text-sm text-foreground">{new Date(trigger.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Dialog */}
      {showEditDialog && (
        <TriggerCreationDialog
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          type={isScheduled ? 'schedule' : 'event'}
          isEditMode={true}
          existingTrigger={triggerConfig}
          onTriggerUpdated={handleEditSave}
        />
      )}

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-background border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground font-medium">Delete Task</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              Are you sure you want to delete "{trigger.name}"? This action cannot be undone and will stop all automated runs from this task.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="hover:bg-muted">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              Delete Task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
