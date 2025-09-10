"use client";

import React, { useState, useEffect } from 'react';
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Activity,
  Copy,
  ExternalLink,
  Loader2
} from 'lucide-react';
import { TriggerProvider, TriggerConfiguration, ScheduleTriggerConfig, EventTriggerConfig } from './types';
import { SimplifiedScheduleConfig } from './providers/simplified-schedule-config';
import { EventTriggerConfigForm } from './providers/event-config';
import { getDialogIcon } from './utils';


interface TriggerConfigDialogProps {
  provider: TriggerProvider;
  existingConfig?: TriggerConfiguration;
  onSave: (config: any) => void;
  onCancel: () => void;
  isLoading?: boolean;
  agentId: string;
  selectedAgent?: string;
  onAgentSelect?: (agentId: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export const TriggerConfigDialog: React.FC<TriggerConfigDialogProps> = ({
  provider,
  existingConfig,
  onSave,
  onCancel,
  isLoading = false,
  agentId,
  selectedAgent,
  onAgentSelect,
  open = true,
  onOpenChange
}) => {
  const [name, setName] = useState(existingConfig?.name || '');
  const [description, setDescription] = useState(existingConfig?.description || '');
  const [isActive, setIsActive] = useState(existingConfig?.is_active ?? true);
  const [config, setConfig] = useState(existingConfig?.config || {});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!name && !existingConfig) {
      setName(`${provider.name} Trigger`);
    }
  }, [provider, existingConfig, name]);

  const validateForm = () => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }
    if (provider.provider_id === 'telegram') {
      if (!config.bot_token) {
        newErrors.bot_token = 'Bot token is required';
      }
    } else if (provider.provider_id === 'slack') {
      if (!config.signing_secret) {
        newErrors.signing_secret = 'Signing secret is required';
      }
    } else if (provider.provider_id === 'schedule') {
      if (!config.cron_expression) {
        newErrors.cron_expression = 'Cron expression is required';
      }
      if (config.execution_type === 'workflow') {
        if (!config.workflow_id) {
          newErrors.workflow_id = 'Workflow selection is required';
        }
      } else {
        if (!config.agent_prompt) {
          newErrors.agent_prompt = 'Agent prompt is required';
        }
      }
    } else if (provider.trigger_type === 'webhook' || provider.provider_id === 'composio') {
      // Validate event-based triggers
      if (config.execution_type === 'workflow') {
        if (!config.workflow_id) {
          newErrors.workflow_id = 'Workflow selection is required';
        }
      } else {
        if (!config.agent_prompt) {
          newErrors.agent_prompt = 'Agent prompt is required';
        }
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (validateForm()) {
      onSave({
        name: name.trim(),
        description: description.trim(),
        is_active: isActive,
        config,
      });
    }
  };

  if (provider.provider_id === 'schedule') {
    return (
      <SimplifiedScheduleConfig
        provider={provider}
        config={config as ScheduleTriggerConfig}
        onChange={setConfig}
        errors={errors}
        agentId={agentId}
        name={name}
        description={description}
        onNameChange={setName}
        onDescriptionChange={setDescription}
        isActive={isActive}
        onActiveChange={setIsActive}
        selectedAgent={selectedAgent}
        onAgentSelect={onAgentSelect}
        open={open}
        onOpenChange={onOpenChange || onCancel}
        onSave={onSave}
      />
    );
  }

  const renderProviderSpecificConfig = () => {
    switch (provider.provider_id) {
      case 'schedule':
        return (
          <SimplifiedScheduleConfig
            provider={provider}
            config={config as ScheduleTriggerConfig}
            onChange={setConfig}
            errors={errors}
            agentId={agentId}
            name={name}
            description={description}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            isActive={isActive}
            onActiveChange={setIsActive}
            selectedAgent={selectedAgent}
            onAgentSelect={onAgentSelect}
            open={open}
            onOpenChange={onOpenChange || onCancel}
            onSave={onSave}
          />
        );
      case 'composio':
        return (
          <EventTriggerConfigForm
            provider={provider}
            config={config as EventTriggerConfig}
            onChange={setConfig}
            errors={errors}
            agentId={agentId}
            name={name}
            description={description}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            isActive={isActive}
            onActiveChange={setIsActive}
          />
        );
      default:
        if (provider.trigger_type === 'webhook') {
          return (
            <EventTriggerConfigForm
              provider={provider}
              config={config as EventTriggerConfig}
              onChange={setConfig}
              errors={errors}
              agentId={agentId}
              name={name}
              description={description}
              onNameChange={setName}
              onDescriptionChange={setDescription}
              isActive={isActive}
              onActiveChange={setIsActive}
            />
          );
        }
        return (
          <div className="text-center py-8 text-muted-foreground">
            <Activity className="h-12 w-12 mx-auto mb-4" />
            <p>Configuration form for {provider.name} is not yet implemented.</p>
          </div>
        );
    }
  };

  return (
    <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden p-0 flex flex-col">
      <div className="flex-1 overflow-y-auto">
        {renderProviderSpecificConfig()}
        {/* {provider.webhook_enabled && existingConfig?.webhook_url && (
          <div className="px-6 pb-6">
            <div className="border-t pt-6">
              <h3 className="text-sm font-medium mb-4">Webhook Information</h3>
              <div className="space-y-2">
                <Label>Webhook URL</Label>
                <div className="flex items-center space-x-2">
                  <Input
                    value={existingConfig.webhook_url}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigator.clipboard.writeText(existingConfig.webhook_url!)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(existingConfig.webhook_url, '_blank')}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use this URL to configure the webhook in {provider.name}
                </p>
              </div>
            </div>
          </div>
        )} */}
      </div>
      <div className="flex-shrink-0 px-6 py-6 border-t bg-muted/20">
        <div className="flex gap-3">
          <Button 
            variant="outline" 
            onClick={onCancel} 
            disabled={isLoading} 
            className="px-8 h-11"
          >
            Cancel
          </Button>
          <Button 
            onClick={handleSave} 
            disabled={isLoading} 
            className="flex-1 h-11 text-base font-medium"
          >
            {isLoading ? (
              <>
                <Loader2 className="animate-spin rounded-full h-4 w-4 mr-2" />
                {existingConfig ? 'Updating Task...' : 'Creating Task...'}
              </>
            ) : (
              `${existingConfig ? 'Update' : 'Create'} Task`
            )}
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}; 