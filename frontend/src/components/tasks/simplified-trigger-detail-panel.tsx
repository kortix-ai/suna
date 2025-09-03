'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import {
  Clock,
  X,
  Trash2,
  Power,
  PowerOff,
  ExternalLink,
  Edit2,
  Activity,
  Sparkles,
  Calendar as CalendarIcon,
  Zap,
  Timer,
  Target,
  Repeat,
  Play,
  Pause
} from 'lucide-react';
import Link from 'next/link';
import { TriggerWithAgent } from '@/hooks/react-query/triggers/use-all-triggers';
import { useDeleteTrigger, useToggleTrigger, useUpdateTrigger } from '@/hooks/react-query/triggers';
import { TriggerConfigDialog } from '@/components/agents/triggers/trigger-config-dialog';
import { useAgentWorkflows } from '@/hooks/react-query/agents/use-agent-workflows';
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

interface SimplifiedTriggerDetailPanelProps {
  trigger: TriggerWithAgent;
  onClose: () => void;
}

const SCHEDULE_PRESETS = [
  { cron: '*/15 * * * *', name: 'Every 15 minutes', icon: <Zap className="h-4 w-4" /> },
  { cron: '*/30 * * * *', name: 'Every 30 minutes', icon: <Timer className="h-4 w-4" /> },
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

export function SimplifiedTriggerDetailPanel({ trigger, onClose }: SimplifiedTriggerDetailPanelProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const deleteMutation = useDeleteTrigger();
  const toggleMutation = useToggleTrigger();
  const updateMutation = useUpdateTrigger();

  const { data: workflows = [] } = useAgentWorkflows(trigger.agent_id);
  const workflowName = workflows.find(w => w.id === trigger.config?.workflow_id)?.name;

  const isScheduled = trigger.trigger_type.toLowerCase() === 'schedule' || trigger.trigger_type.toLowerCase() === 'scheduled';
  const scheduleDisplay = getScheduleDisplay(trigger.config?.cron_expression);

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

  const provider = {
    provider_id: isScheduled ? 'schedule' : trigger.provider_id,
    name: trigger.name,
    description: trigger.description || '',
    trigger_type: trigger.trigger_type,
    webhook_enabled: !!trigger.webhook_url,
    config_schema: {}
  };

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

  return (
    <div className={"h-full bg-white flex flex-col w-full sm:w-[440px] xl:w-2xl"}>
      {/* Header */}
      <div className="px-8 py-6 border-b border-gray-200">
        <div className="flex items-start justify-between mb-6">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-2xl font-medium text-black">{trigger.name}</h1>
              <Badge
                variant={trigger.is_active ? "highlight" : "secondary"}
                className="text-xs"
              >
                {trigger.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
            {trigger.description && (
              <p className="text-gray-600 text-sm leading-relaxed">{trigger.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowEditDialog(true)}
              className="border-gray-200 hover:bg-gray-50"
            >
              <Edit2 className="h-4 w-4 mr-2" />
              Edit
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isLoading}
              className="border-gray-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 hover:bg-gray-100"
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
              "flex-1 border-gray-200",
              trigger.is_active
                ? "hover:bg-gray-50"
                : "bg-black hover:bg-gray-900 text-white"
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
      <div className="flex-1 overflow-y-auto px-8 py-6 space-y-8">
        {/* Schedule Info */}
        {isScheduled && (
          <div className="border border-gray-200 rounded-lg p-6 bg-white">
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-gray-100">
                <Clock className="h-5 w-5 text-gray-700" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-black mb-1">Schedule</h3>
                <p className="text-sm text-gray-600">{scheduleDisplay.name}</p>
              </div>
            </div>
          </div>
        )}

        {/* Execution Details */}
        <div className="border border-gray-200 rounded-lg p-6 bg-white">
          <div className="flex items-start gap-4 mb-4">
            <div className="p-2 rounded-lg bg-gray-100">
              {trigger.config?.execution_type === 'agent' ? (
                <Sparkles className="h-5 w-5 text-gray-700" />
              ) : (
                <Activity className="h-5 w-5 text-gray-700" />
              )}
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-black mb-1">
                {trigger.config?.execution_type === 'agent' ? 'Agent Instructions' : 'Workflow Execution'}
              </h3>
              <p className="text-sm text-gray-600">
                {trigger.config?.execution_type === 'agent'
                  ? 'Custom prompt for the agent'
                  : `Runs workflow: ${workflowName || 'Unknown'}`
                }
              </p>
            </div>
          </div>

          {trigger.config?.execution_type === 'agent' && trigger.config.agent_prompt && (
            <div className="mt-4 p-4 rounded-lg bg-gray-50 border border-gray-200">
              <p className="text-sm font-mono text-gray-800 whitespace-pre-wrap leading-relaxed">
                {trigger.config.agent_prompt}
              </p>
            </div>
          )}

          {trigger.config?.execution_type === 'workflow' && trigger.config.workflow_input && (
            <div className="mt-4 p-4 rounded-lg bg-gray-50 border border-gray-200">
              <p className="text-xs text-gray-500 mb-2 font-medium">Workflow Input:</p>
              <pre className="text-xs font-mono text-gray-800 overflow-x-auto">
                {JSON.stringify(trigger.config.workflow_input, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Agent Info */}
        <div className="border border-gray-200 rounded-lg p-6 bg-white">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <AgentAvatar
                agentId={trigger.agent_id}
                size={40}
                fallbackName={trigger.agent_name}
              />
              <div>
                <h3 className="font-medium text-black">{trigger.agent_name || 'Unknown Agent'}</h3>
                <p className="text-sm text-gray-600">Assigned Agent</p>
              </div>
            </div>
            <Link
              href={`/agents/config/${trigger.agent_id}`}
              className="p-2 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <ExternalLink className="h-4 w-4 text-gray-500" />
            </Link>
          </div>
        </div>

        {/* Technical Details */}
        <div className="border border-gray-200 rounded-lg p-6 bg-white">
          <h3 className="font-medium text-black mb-4">Technical Details</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-b-0">
              <span className="text-sm text-gray-600">Type</span>
              <span className="text-sm font-mono text-gray-900">{trigger.trigger_type}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-b-0">
              <span className="text-sm text-gray-600">Provider</span>
              <span className="text-sm font-mono text-gray-900">{trigger.provider_id}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b border-gray-100 last:border-b-0">
              <span className="text-sm text-gray-600">Created</span>
              <span className="text-sm text-gray-900">{new Date(trigger.created_at).toLocaleDateString()}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-sm text-gray-600">Last Updated</span>
              <span className="text-sm text-gray-900">{new Date(trigger.updated_at).toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Edit Dialog */}
      {showEditDialog && (
        <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
          <TriggerConfigDialog
            provider={provider}
            existingConfig={triggerConfig}
            onSave={handleEditSave}
            onCancel={() => setShowEditDialog(false)}
            isLoading={updateMutation.isPending}
            agentId={trigger.agent_id}
          />
        </Dialog>
      )}

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="bg-white border border-gray-200">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-black font-medium">Delete Task</AlertDialogTitle>
            <AlertDialogDescription className="text-gray-600">
              Are you sure you want to delete "{trigger.name}"? This action cannot be undone and will stop all automated runs from this task.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-gray-200 hover:bg-gray-50">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-black hover:bg-gray-900 text-white"
            >
              Delete Task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
