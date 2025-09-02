"use client";

import React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Edit,
  Trash2,
  ExternalLink,
  MessageSquare,
  Webhook,
  Clock,
  Mail,
  Github,
  Gamepad2,
  Activity,
  Copy
} from 'lucide-react';
import { TriggerConfiguration } from './types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
import { getTriggerIcon } from './utils';
import { cn, truncateString } from '@/lib/utils';

interface ConfiguredTriggersListProps {
  triggers: TriggerConfiguration[];
  onEdit: (trigger: TriggerConfiguration) => void;
  onRemove: (trigger: TriggerConfiguration) => void;
  onToggle: (trigger: TriggerConfiguration) => void;
  isLoading?: boolean;
}

const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.error('Failed to copy text: ', err);
  }
};

const getCronDescription = (cron: string): string => {
  const cronDescriptions: Record<string, string> = {
    '0 9 * * *': 'Daily at 9:00 AM',
    '0 18 * * *': 'Daily at 6:00 PM',
    '0 9 * * 1-5': 'Weekdays at 9:00 AM',
    '0 10 * * 1-5': 'Weekdays at 10:00 AM',
    '0 9 * * 1': 'Every Monday at 9:00 AM',
    '0 9 1 * *': 'Monthly on the 1st at 9:00 AM',
    '0 9 1 1 *': 'Yearly on Jan 1st at 9:00 AM',
    '0 */2 * * *': 'Every 2 hours',
    '*/30 * * * *': 'Every 30 minutes',
    '0 0 * * *': 'Daily at midnight',
    '0 12 * * *': 'Daily at noon',
    '0 9 * * 0': 'Every Sunday at 9:00 AM',
    '0 9 * * 6': 'Every Saturday at 9:00 AM',
  };

  return cronDescriptions[cron] || cron;
};

export const ConfiguredTriggersList: React.FC<ConfiguredTriggersListProps> = ({
  triggers,
  onEdit,
  onRemove,
  onToggle,
  isLoading = false,
}) => {
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [triggerToDelete, setTriggerToDelete] = React.useState<TriggerConfiguration | null>(null);

  const handleDeleteClick = (trigger: TriggerConfiguration) => {
    setTriggerToDelete(trigger);
    setDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (triggerToDelete) {
      onRemove(triggerToDelete);
      setTriggerToDelete(null);
      setDeleteDialogOpen(false);
    }
  };

  return (
    <TooltipProvider>
      <div className="space-y-2">
        {triggers.map((trigger) => (
          <div
            key={trigger.trigger_id}
            className={`flex items-stretch justify-between p-4 rounded-xl border transition-all duration-200 overflow-hidden ${trigger.is_active
              ? "bg-card hover:bg-muted/50 border-border"
              : "bg-muted/20 hover:bg-muted/30 border-muted-foreground/30"
              }`}
          >
            <div className="flex items-stretch space-x-4 flex-1 min-w-0">
              <div className={`h-10 min-h-10 max-h-10 w-10 rounded-xl border transition-colors flex-shrink-0 flex items-center justify-center ${trigger.is_active
                ? "bg-muted border-border"
                : "bg-muted/50 border-muted-foreground/20"
                } ${trigger.is_active ? "" : "opacity-70"}`}>
                {getTriggerIcon(trigger.trigger_type)}
              </div>

              <div className="flex-1 min-w-0 overflow-hidden">
                <div className="flex items-center space-x-2 mb-1">
                  <h4 className={`text-sm font-medium truncate transition-colors ${trigger.is_active ? "text-foreground" : "text-muted-foreground"
                    }`}>
                    {trigger.name}
                  </h4>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className={cn('h-2 w-2 rounded-full', trigger.is_active ? 'bg-green-500' : 'bg-red-500')} />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{trigger.is_active ? 'Active' : 'Inactive'}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>

                {trigger.description && (
                  <p className={`text-xs truncate transition-colors ${trigger.is_active ? "text-muted-foreground" : "text-muted-foreground/80"
                    }`}>
                    {truncateString(trigger.description, 50)}
                  </p>
                )}
                {trigger.trigger_type === 'schedule' && trigger.config && (
                  <div className={`text-xs mt-1 transition-colors ${trigger.is_active ? "text-muted-foreground" : "text-muted-foreground/80"
                    }`}>
                    {trigger.config.execution_type === 'agent' && trigger.config.agent_prompt && (
                      <p>Prompt: {truncateString(trigger.config.agent_prompt, 40)}</p>
                    )}
                    {trigger.config.execution_type === 'workflow' && trigger.config.workflow_id && (
                      <p>Workflow: {trigger.config.workflow_id}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2 flex-shrink-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center">
                    <Switch
                      checked={trigger.is_active}
                      onCheckedChange={() => onToggle(trigger)}
                      disabled={isLoading}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{trigger.is_active ? 'Disable' : 'Enable'} trigger</p>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(trigger)}
                    className={`h-8 w-8 p-0 transition-opacity ${trigger.is_active ? "" : "opacity-70"
                      }`}
                    disabled={isLoading}
                  >
                    <Edit className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Edit trigger</p>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDeleteClick(trigger)}
                    className={`h-8 w-8 p-0 text-destructive hover:text-destructive transition-opacity ${trigger.is_active ? "" : "opacity-70"
                      }`}
                    disabled={isLoading}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Delete trigger</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        ))}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Trigger</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{triggerToDelete?.name}"? This action cannot be undone and will stop all automated runs from this trigger.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive hover:bg-destructive/90 text-white"
            >
              Delete Trigger
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}; 