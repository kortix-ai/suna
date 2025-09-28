"use client";

import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { ConfiguredTriggersList } from './configured-triggers-list';
import { TriggerCreationDialog } from '../../triggers/trigger-creation-dialog';
import { TriggerConfiguration, TriggerProvider } from './types';
import { 
  useAgentTriggers, 
  useCreateTrigger, 
  useUpdateTrigger, 
  useDeleteTrigger, 
  useToggleTrigger,
  useTriggerProviders 
} from '@/hooks/react-query/triggers';
import { toast } from 'sonner';
import { OneClickIntegrations } from './one-click-integrations';

interface AgentTriggersConfigurationProps {
  agentId: string;
}


export const AgentTriggersConfiguration: React.FC<AgentTriggersConfigurationProps> = ({
  agentId,
}) => {
  const [configuringProvider, setConfiguringProvider] = useState<TriggerProvider | null>(null);
  const [editingTrigger, setEditingTrigger] = useState<TriggerConfiguration | null>(null);

  const { data: triggers = [], isLoading, error } = useAgentTriggers(agentId);
  const { data: providers = [] } = useTriggerProviders();
  const createTriggerMutation = useCreateTrigger();
  const updateTriggerMutation = useUpdateTrigger();
  const deleteTriggerMutation = useDeleteTrigger();
  const toggleTriggerMutation = useToggleTrigger();

  const handleEditTrigger = (trigger: TriggerConfiguration) => {
    setEditingTrigger(trigger);
    
    const provider = providers.find(p => p.provider_id === trigger.provider_id);
    if (provider) {
      setConfiguringProvider(provider);
    } else {
      setConfiguringProvider({
        provider_id: trigger.provider_id,
        name: trigger.trigger_type,
        description: '',
        trigger_type: trigger.trigger_type,
        webhook_enabled: !!trigger.webhook_url,
        config_schema: {}
      });
    }
  };

  const handleRemoveTrigger = async (trigger: TriggerConfiguration) => {
    try {
      await deleteTriggerMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        agentId: trigger.agent_id
      });
      toast.success('Task deleted successfully');
    } catch (error) {
      toast.error('Failed to delete trigger');
      console.error('Error deleting trigger:', error);
    }
  };

  const handleSaveTrigger = async (config: any) => {
    try {
      if (editingTrigger) {
        await updateTriggerMutation.mutateAsync({
          triggerId: editingTrigger.trigger_id,
          name: config.name,
          description: config.description,
          config: config.config,
          is_active: config.is_active,
        });
        toast.success('Trigger updated successfully');
      } else {
        await createTriggerMutation.mutateAsync({
          agentId,
          provider_id: configuringProvider!.provider_id,
          name: config.name,
          description: config.description,
          config: config.config,
        });
        toast.success('Trigger created successfully');
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to save trigger');
      console.error('Error saving trigger:', error);
    }
    setConfiguringProvider(null);
    setEditingTrigger(null);
  };

  const handleToggleTrigger = async (trigger: TriggerConfiguration) => {
    try {
      await toggleTriggerMutation.mutateAsync({
        triggerId: trigger.trigger_id,
        isActive: !trigger.is_active,
      });
      toast.success(`Trigger ${!trigger.is_active ? 'enabled' : 'disabled'}`);
    } catch (error) {
      toast.error('Failed to toggle trigger');
      console.error('Error toggling trigger:', error);
    }
  };

  if (error) {
    return (
      <div className="rounded-xl p-6 border border-destructive/20 bg-destructive/5">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-destructive/10 rounded-lg">
            <Zap className="h-5 w-5 text-destructive" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-destructive">Error Loading Triggers</h3>
            <p className="text-sm text-muted-foreground">
              {error instanceof Error ? error.message : 'Failed to load triggers'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <OneClickIntegrations agentId={agentId} />
      
      {triggers.length > 0 && (
        <ConfiguredTriggersList
          triggers={triggers}
          onEdit={handleEditTrigger}
          onRemove={handleRemoveTrigger}
          onToggle={handleToggleTrigger}
          isLoading={deleteTriggerMutation.isPending || toggleTriggerMutation.isPending}
        />
      )}

      {!isLoading && triggers.length === 0 && (
        <div className="text-center py-12 px-6 bg-muted/30 rounded-xl border-2 border-dashed border-border">
          <div className="mx-auto w-12 h-12 bg-muted rounded-full flex items-center justify-center mb-4 border">
            <Zap className="h-6 w-6 text-muted-foreground" />
          </div>
          <h4 className="text-sm font-semibold text-foreground">
            No triggers configured
          </h4>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">
            Click on a trigger provider above to get started
          </p>
        </div>
      )}
      
      {configuringProvider && (
        <TriggerCreationDialog
          open={!!configuringProvider}
          onOpenChange={() => setConfiguringProvider(null)}
          type={configuringProvider.provider_id === 'schedule' ? 'schedule' : 'event'}
          isEditMode={!!editingTrigger}
          existingTrigger={editingTrigger}
          onTriggerCreated={handleSaveTrigger}
          onTriggerUpdated={handleSaveTrigger}
        />
      )}
    </div>
  );
}; 