"use client";

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, AlertCircle, Clock, PlugZap } from 'lucide-react';
import { TriggerConfigDialog } from './trigger-config-dialog';
import { TriggerProvider } from './types';
import { Dialog } from '@/components/ui/dialog';
import {
  useInstallOAuthIntegration,
  useUninstallOAuthIntegration,
  useOAuthCallbackHandler
} from '@/hooks/react-query/triggers/use-oauth-integrations';
import {
  useAgentTriggers,
  useCreateTrigger,
  useDeleteTrigger
} from '@/hooks/react-query/triggers';
import { toast } from 'sonner';
import { EventBasedTriggerDialog } from './event-based-trigger-dialog';
import { config, EnvMode } from '@/lib/config';

interface OneClickIntegrationsProps {
  agentId: string;
}

const OAUTH_PROVIDERS = {
  schedule: {
    name: 'Create Schedule Trigger',
    icon: <Clock className="h-4 w-4" color="#10b981" />,
    isOAuth: false
  }
} as const;

type ProviderKey = keyof typeof OAUTH_PROVIDERS;

export const OneClickIntegrations: React.FC<OneClickIntegrationsProps> = ({
  agentId
}) => {
  const [configuringSchedule, setConfiguringSchedule] = useState(false);
  const [showEventDialog, setShowEventDialog] = useState(false);
  const { data: triggers = [] } = useAgentTriggers(agentId);
  const installMutation = useInstallOAuthIntegration();
  const uninstallMutation = useUninstallOAuthIntegration();
  const createTriggerMutation = useCreateTrigger();
  const deleteTriggerMutation = useDeleteTrigger();
  const { handleCallback } = useOAuthCallbackHandler();

  useEffect(() => {
    handleCallback();
  }, []);

  const handleInstall = async (provider: ProviderKey) => {
    if (provider === 'schedule') {
      setConfiguringSchedule(true);
      return;
    }

    try {
      await installMutation.mutateAsync({
        agent_id: agentId,
        provider: provider
      });
    } catch (error) {
      console.error(`Error installing ${provider}:`, error);
    }
  };

  const handleUninstall = async (provider: ProviderKey, triggerId?: string) => {
    if (provider === 'schedule' && triggerId) {
      try {
        await deleteTriggerMutation.mutateAsync({
          triggerId,
          agentId
        });
        toast.success('Schedule trigger removed successfully');
      } catch (error) {
        toast.error('Failed to remove schedule trigger');
        console.error('Error removing schedule trigger:', error);
      }
      return;
    }

    try {
      await uninstallMutation.mutateAsync(triggerId!);
    } catch (error) {
      console.error('Error uninstalling integration:', error);
    }
  };

  const handleScheduleSave = async (config: any) => {
    try {
      await createTriggerMutation.mutateAsync({
        agentId,
        provider_id: 'schedule',
        name: config.name || 'Scheduled Trigger',
        description: config.description || 'Automatically scheduled trigger',
        config: config.config,
      });
      toast.success('Schedule trigger created successfully');
      setConfiguringSchedule(false);
    } catch (error: any) {
      toast.error(error.message || 'Failed to create schedule trigger');
      console.error('Error creating schedule trigger:', error);
    }
  };

  const getIntegrationForProvider = (provider: ProviderKey) => {
    if (provider === 'schedule') {
      return triggers.find(trigger => trigger.trigger_type === 'schedule');
    }
  };

  const isProviderInstalled = (provider: ProviderKey) => {
    return !!getIntegrationForProvider(provider);
  };

  const getTriggerId = (provider: ProviderKey) => {
    const integration = getIntegrationForProvider(provider);
    if (provider === 'schedule') {
      return integration?.trigger_id;
    }
    return integration?.trigger_id;
  };

  const scheduleProvider: TriggerProvider = {
    provider_id: 'schedule',
    name: 'Schedule',
    trigger_type: 'schedule',
    webhook_enabled: true,
    config_schema: {}
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">

        {Object.entries(OAUTH_PROVIDERS).map(([providerId, config]) => {
          const provider = providerId as ProviderKey;
          const isInstalled = isProviderInstalled(provider);
          const isLoading = installMutation.isPending || uninstallMutation.isPending ||
            (provider === 'schedule' && (createTriggerMutation.isPending || deleteTriggerMutation.isPending));
          const triggerId = getTriggerId(provider);

          const buttonText = provider === 'schedule'
            ? config.name
            : (isInstalled ? `Disconnect ${config.name}` : `Connect ${config.name}`);

          return (
            <Button
              key={providerId}
              variant="outline"
              size='sm'
              onClick={() => {
                if (provider === 'schedule') {
                  handleInstall(provider);
                } else {
                  // eslint-disable-next-line @typescript-eslint/no-unused-expressions
                  isInstalled ? handleUninstall(provider, triggerId) : handleInstall(provider);
                }
              }}
              disabled={isLoading}
              className="flex items-center"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                config.icon
              )}
              {buttonText}
            </Button>
          );
        })}
        <Button
          variant="default"
          size='sm'
          onClick={() => setShowEventDialog(true)}
          className="flex items-center gap-2"
        >
          <PlugZap className="h-4 w-4" /> App-based Trigger
        </Button>
      </div>
      <EventBasedTriggerDialog open={showEventDialog} onOpenChange={setShowEventDialog} agentId={agentId} />
      {configuringSchedule && (
        <Dialog open={configuringSchedule} onOpenChange={setConfiguringSchedule}>
          <TriggerConfigDialog
            provider={scheduleProvider}
            existingConfig={null}
            onSave={handleScheduleSave}
            onCancel={() => setConfiguringSchedule(false)}
            isLoading={createTriggerMutation.isPending}
            agentId={agentId}
          />
        </Dialog>
      )}
    </div>
  );
};
