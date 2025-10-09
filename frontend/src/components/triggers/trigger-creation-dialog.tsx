"use client";

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ArrowRight, Clock, PlugZap } from 'lucide-react';
import { EventBasedTriggerDialog } from '@/components/agents/triggers/event-based-trigger-dialog';
import { SimplifiedScheduleConfig } from '@/components/agents/triggers/providers/simplified-schedule-config';
import { ScheduleTriggerConfig } from '@/components/agents/triggers/types';
import { useCreateTrigger, useUpdateTrigger } from '@/hooks/react-query/triggers';
import { toast } from 'sonner';
import { AgentSelector } from '@/components/agents/agent-selector';

interface TriggerCreationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'schedule' | 'event';
  onTriggerCreated?: (triggerId: string) => void;
  isEditMode?: boolean;
  existingTrigger?: any; // TriggerConfiguration for edit mode
  onTriggerUpdated?: (triggerId: string) => void;
}

export function TriggerCreationDialog({
  open,
  onOpenChange,
  type,
  onTriggerCreated,
  isEditMode = false,
  existingTrigger,
  onTriggerUpdated
}: TriggerCreationDialogProps) {
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [step, setStep] = useState<'agent' | 'config'>('agent');
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [config, setConfig] = useState<ScheduleTriggerConfig>({
    cron_expression: ''
  });
  const createTriggerMutation = useCreateTrigger();
  const updateTriggerMutation = useUpdateTrigger();

  // Initialize form for edit mode
  React.useEffect(() => {
    if (isEditMode && existingTrigger && open) {
      setSelectedAgent(existingTrigger.agent_id || '');
      setName(existingTrigger.name || '');
      setDescription(existingTrigger.description || '');
      setConfig(existingTrigger.config || { cron_expression: '' });
      // Skip agent selection step in edit mode
      setStep('config');
    }
  }, [isEditMode, existingTrigger, open]);

  const scheduleProvider = {
    provider_id: 'schedule',
    name: 'Schedule',
    trigger_type: 'schedule',
    webhook_enabled: true,
    config_schema: {}
  };

  const handleScheduleSave = async (data: { name: string; description: string; config: any; is_active: boolean }) => {
    if (!selectedAgent) {
      toast.error('Please select an agent');
      return;
    }

    try {
      if (isEditMode && existingTrigger) {
        // Update existing trigger
        await updateTriggerMutation.mutateAsync({
          triggerId: existingTrigger.trigger_id,
          name: data.name || 'Scheduled Trigger',
          description: data.description || 'Automatically scheduled trigger',
          config: data.config,
          is_active: data.is_active,
        });
        toast.success('Schedule trigger updated successfully');

        if (onTriggerUpdated && existingTrigger.trigger_id) {
          onTriggerUpdated(existingTrigger.trigger_id);
        }
      } else {
        // Create new trigger
        const newTrigger = await createTriggerMutation.mutateAsync({
          agentId: selectedAgent,
          provider_id: 'schedule',
          name: data.name || 'Scheduled Trigger',
          description: data.description || 'Automatically scheduled trigger',
          config: data.config,
        });
        toast.success('Schedule trigger created successfully');

        if (onTriggerCreated && newTrigger?.trigger_id) {
          onTriggerCreated(newTrigger.trigger_id);
        }
      }

      handleClose();
    } catch (error: any) {
      toast.error(error.message || `Failed to ${isEditMode ? 'update' : 'create'} schedule trigger`);
      console.error(`Error ${isEditMode ? 'updating' : 'creating'} schedule trigger:`, error);
    }
  };

  const handleClose = () => {
    setSelectedAgent('');
    setStep('agent');
    onOpenChange(false);
  };

  const handleAgentSelect = () => {
    setStep('config');
  };

  if (!open) return null;

  // Step 1: Agent Selection (for both types)
  if (step === 'agent') {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {type === 'schedule' ? (
                <>
                  <Clock className="h-5 w-5" />
                  {isEditMode ? 'Edit Scheduled Task' : 'Create Scheduled Task'}
                </>
              ) : (
                <>
                  <PlugZap className="h-5 w-5" />
                  {isEditMode ? 'Edit App-based Task' : 'Create App-based Task'}
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {isEditMode ? 'Update the agent for this task' : 'First, select which agent should handle this task'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <AgentSelector
              selectedAgentId={selectedAgent}
              onAgentSelect={setSelectedAgent}
              placeholder="Choose an agent"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button onClick={handleAgentSelect} disabled={!selectedAgent}>
              Next
              <ArrowRight className="h-4 w-4 ml-2" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // Step 2: Configuration
  if (type === 'schedule') {
    return (
      <SimplifiedScheduleConfig
        provider={scheduleProvider}
        config={config}
        onChange={setConfig}
        errors={{}}
        agentId={selectedAgent}
        name={name}
        description={description}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        isActive={true}
        onActiveChange={() => { }}
        selectedAgent={selectedAgent}
        onAgentSelect={setSelectedAgent}
        open={open}
        onOpenChange={onOpenChange}
        onSave={handleScheduleSave}
        isEditMode={isEditMode}
      />
    );
  }

  return (
    <EventBasedTriggerDialog
      open={open}
      onOpenChange={handleClose}
      agentId={selectedAgent}
      onTriggerCreated={onTriggerCreated}
      isEditMode={isEditMode}
      existingTrigger={existingTrigger}
      onTriggerUpdated={onTriggerUpdated}
    />
  );
} 