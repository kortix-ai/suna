"use client";

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, AlertCircle, Clock, PlugZap, Lock, Zap } from 'lucide-react';
import { SimplifiedScheduleConfig } from './providers/simplified-schedule-config';
import { TriggerProvider, ScheduleTriggerConfig } from './types';

import {
  useInstallOAuthIntegration,
  useUninstallOAuthIntegration,
  useOAuthCallbackHandler
} from '@/hooks/triggers/use-oauth-integrations';
import {
  useAgentTriggers,
  useCreateTrigger,
  useDeleteTrigger
} from '@/hooks/triggers';
import { toast } from 'sonner';
import { EventBasedTriggerDialog } from './event-based-trigger-dialog';
import { config, EnvMode, isLocalMode } from '@/lib/config';
import { useAccountState } from '@/hooks/billing';
import { usePricingModalStore } from '@/stores/pricing-modal-store';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

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
  const { data: accountState } = useAccountState();
  const { openPricingModal } = usePricingModalStore();
  
  const isFreeTier = accountState && (
    accountState.subscription?.tier_key === 'free' ||
    accountState.tier?.name === 'free'
  ) && !isLocalMode();
  
  // Schedule trigger form state
  const [scheduleConfig, setScheduleConfig] = useState<ScheduleTriggerConfig>({
    cron_expression: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
  const [scheduleName, setScheduleName] = useState('');
  const [scheduleDescription, setScheduleDescription] = useState('');
  const [scheduleIsActive, setScheduleIsActive] = useState(true);

  const handleScheduleConfigChange = (config: ScheduleTriggerConfig) => {
    setScheduleConfig(config);
  };
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
      // Reset form state when opening
      setScheduleConfig({
        cron_expression: '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
      });
      setScheduleName('');
      setScheduleDescription('');
      setScheduleIsActive(true);
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

  const handleScheduleSave = async (data: {
    name: string;
    description: string;
    config: any;
    is_active: boolean;
  }) => {
    try {
      await createTriggerMutation.mutateAsync({
        agentId,
        provider_id: 'schedule',
        name: data.name || 'Scheduled Trigger',
        description: data.description || 'Automatically scheduled trigger',
        config: { ...data.config, is_active: data.is_active },
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
    <TooltipProvider>
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

            if (isFreeTier && provider === 'schedule') {
              return (
                <Tooltip key={providerId}>
                  <TooltipTrigger asChild>
                    <div className="relative">
                      <Button
                        variant="outline"
                        size='sm'
                        disabled={true}
                        className="flex items-center opacity-50 cursor-not-allowed"
                      >
                        <Lock className="h-4 w-4 mr-2" />
                        {buttonText}
                      </Button>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="text-xs">UPGRADE for time-based automation</p>
                  </TooltipContent>
                </Tooltip>
              );
            }

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
          {isFreeTier ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="relative">
                  <Button
                    variant="default"
                    size='sm'
                    disabled={true}
                    className="flex items-center gap-2 opacity-50 cursor-not-allowed"
                  >
                    <Lock className="h-4 w-4" />
                    App-based Trigger
                  </Button>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">UPGRADE for event-based automation (email, CRM, etc.)</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="default"
              size='sm'
              onClick={() => setShowEventDialog(true)}
              className="flex items-center gap-2"
            >
              <PlugZap className="h-4 w-4" /> App-based Trigger
            </Button>
          )}
        </div>
        {isFreeTier && (
          <div 
            className="relative overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-4 cursor-pointer hover:border-primary/50 hover:from-primary/15 transition-all group"
            onClick={() => openPricingModal()}
          >
            <div className="flex items-start gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/15 border border-primary/20 flex-shrink-0 group-hover:bg-primary/20 transition-colors">
                <Zap className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground mb-1">Unlock Automation</p>
                <p className="text-xs text-muted-foreground leading-relaxed">Run your AI Workers on autopilot with scheduled tasks and app-based triggers</p>
              </div>
              <Button
                size="sm"
                className="text-xs h-8 flex-shrink-0"
              >
                Upgrade
              </Button>
            </div>
          </div>
        )}
        <EventBasedTriggerDialog open={showEventDialog} onOpenChange={setShowEventDialog} agentId={agentId} />
        <SimplifiedScheduleConfig
          provider={scheduleProvider}
          config={scheduleConfig}
          onChange={handleScheduleConfigChange}
          errors={{}}
          agentId={agentId}
          name={scheduleName}
          description={scheduleDescription}
          onNameChange={setScheduleName}
          onDescriptionChange={setScheduleDescription}
          isActive={scheduleIsActive}
          onActiveChange={setScheduleIsActive}
          open={configuringSchedule}
          onOpenChange={setConfiguringSchedule}
          onSave={handleScheduleSave}
        />
      </div>
    </TooltipProvider>
  );
};
