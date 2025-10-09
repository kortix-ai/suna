import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription 
} from '@/components/ui/dialog';
import { 
  Loader2, 
  Shield, 
  Download,
  ArrowRight,
  CheckCircle,
  Zap
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProfileConnector } from './streamlined-profile-connector';
import { CustomServerStep } from './custom-server-step';
import type { MarketplaceTemplate, SetupStep } from './types';
import { AgentAvatar } from '@/components/thread/content/agent-avatar';
import { TriggerConfigStep } from './trigger-config-step';
import { TriggerVariablesStep, type TriggerVariable } from './trigger-variables-step';
import { toast } from 'sonner';

interface StreamlinedInstallDialogProps {
  item: MarketplaceTemplate | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (
    item: MarketplaceTemplate, 
    instanceName: string, 
    profileMappings: Record<string, string>, 
    customMcpConfigs: Record<string, Record<string, any>>,
    triggerConfigs?: Record<string, Record<string, any>>,
    triggerVariables?: Record<string, Record<string, string>>
  ) => Promise<void>;
  isInstalling: boolean;
  onTriggerVariablesRequired?: (variables: Record<string, TriggerVariable>) => void;
}

export const StreamlinedInstallDialog: React.FC<StreamlinedInstallDialogProps> = ({
  item,
  open,
  onOpenChange,
  onInstall,
  isInstalling,
  onTriggerVariablesRequired
}) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [instanceName, setInstanceName] = useState('');
  const [profileMappings, setProfileMappings] = useState<Record<string, string>>({});
  const [customMcpConfigs, setCustomMcpConfigs] = useState<Record<string, Record<string, any>>>({});
  const [triggerConfigs, setTriggerConfigs] = useState<Record<string, Record<string, any>>>({});
  const [triggerVariables, setTriggerVariables] = useState<Record<string, Record<string, string>>>({});
  const [missingTriggerVariables, setMissingTriggerVariables] = useState<Record<string, TriggerVariable>>({});
  const [setupSteps, setSetupSteps] = useState<SetupStep[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const generateSetupSteps = useCallback(() => {
    if (!item?.mcp_requirements) return [];
    
    const steps: SetupStep[] = [];
    const triggers = item.config?.triggers || [];
    
    item.mcp_requirements
      .filter(req => {
        return req.custom_type === 'composio' || 
               req.qualified_name?.startsWith('composio.') || 
               req.qualified_name === 'composio';
      })
      .forEach(req => {
        const app_slug = req.app_slug || (req.qualified_name?.startsWith('composio.') 
          ? req.qualified_name.split('.')[1] 
          : 'composio');
        
        const stepId = req.source === 'trigger' && req.trigger_index !== undefined
          ? `${req.qualified_name}_trigger_${req.trigger_index}`
          : req.qualified_name;
        
        const trigger = req.source === 'trigger' && req.trigger_index !== undefined 
          ? triggers[req.trigger_index] : null;
        const triggerSlug = trigger?.config?.trigger_slug;
        
        const triggerFields = req.source === 'trigger' ? trigger?.config?.trigger_fields : undefined;
        
        steps.push({
          id: stepId,
          title: req.source === 'trigger' ? req.display_name : `Connect ${req.display_name}`,
          description: req.source === 'trigger' && triggerFields
            ? `Select a ${req.display_name.split(' (')[0]} profile and configure trigger settings`
            : req.source === 'trigger'
            ? `Select a ${req.display_name.split(' (')[0]} profile for this trigger`
            : `Select an existing ${req.display_name} profile or create a new one`,
          type: 'composio_profile',
          service_name: req.display_name,
          qualified_name: req.qualified_name,
          app_slug: app_slug === 'composio' ? 'composio' : app_slug,
          app_name: req.display_name,
          source: req.source,
          trigger_slug: triggerSlug,
          trigger_index: req.trigger_index,
          trigger_fields: triggerFields || undefined
        });
      });

    item.mcp_requirements
      .filter(req => {
        return !req.custom_type && 
               !req.qualified_name?.startsWith('composio.') && 
               req.qualified_name !== 'composio';
      })
      .forEach(req => {
        const stepId = req.source === 'trigger' && req.trigger_index !== undefined
          ? `${req.qualified_name}_trigger_${req.trigger_index}`
          : req.qualified_name;
        
        steps.push({
          id: stepId,
          title: req.source === 'trigger' ? req.display_name : `Connect ${req.display_name}`,
          description: req.source === 'trigger'
            ? `Select a ${req.display_name} profile for this trigger`
            : `Select or create a credential profile for ${req.display_name}`,
          type: 'credential_profile',
          service_name: req.display_name,
          qualified_name: req.qualified_name,
          source: req.source
        });
      });

    item.mcp_requirements
      .filter(req => req.custom_type && req.custom_type !== 'composio')
      .forEach(req => {
        steps.push({
          id: req.qualified_name,
          title: `Configure ${req.display_name}`,
          description: `Enter your ${req.display_name} server details`,
          type: 'custom_server',
          service_name: req.display_name,
          qualified_name: req.qualified_name,
          custom_type: req.custom_type,
          required_config: req.required_config || []
        });
      });

    return steps;
  }, [item]);

  useEffect(() => {
    if (open && item) {
      setCurrentStep(0);
      setInstanceName(item.name);
      setProfileMappings({});
      setCustomMcpConfigs({});
      setTriggerConfigs({});
      setTriggerVariables({});
      setMissingTriggerVariables({});
      setIsLoading(true);
      
      const steps = generateSetupSteps();
      setSetupSteps(steps);
      
      const triggers = item.config?.triggers || [];
      const triggerVars: Record<string, TriggerVariable> = {};
      
      triggers.forEach((trigger, index) => {
        const config = trigger.config || {};
        const variables = config.trigger_variables || [];
        const agent_prompt = config.agent_prompt || '';
        let extractedVars = variables;
        if (extractedVars.length === 0 && agent_prompt) {
          const pattern = /\{\{(\w+)\}\}/g;
          const matches = [...agent_prompt.matchAll(pattern)];
          extractedVars = [...new Set(matches.map(m => m[1]))];
        }
        
        if (extractedVars.length > 0) {
          triggerVars[`trigger_${index}`] = {
            trigger_name: trigger.name || `Trigger ${index + 1}`,
            trigger_index: index,
            variables: extractedVars,
            agent_prompt: agent_prompt
          };
        }
      });
      
      setMissingTriggerVariables(triggerVars);
      setIsLoading(false);
    }
  }, [open, item, generateSetupSteps]);

  const handleInstanceNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInstanceName(e.target.value);
  }, []);

  const handleProfileSelect = useCallback((stepId: string, profileId: string | null) => {
    setProfileMappings(prev => ({
      ...prev,
      [stepId]: profileId || ''
    }));
  }, []);

  const handleCustomConfigUpdate = useCallback((qualifiedName: string, config: Record<string, any>) => {
    setCustomMcpConfigs(prev => ({
      ...prev,
      [qualifiedName]: config
    }));
  }, []);

  const handleTriggerConfigUpdate = useCallback((stepId: string, config: Record<string, any>) => {
    setTriggerConfigs(prev => ({
      ...prev,
      [stepId]: config
    }));
  }, []);

  const isCurrentStepComplete = useCallback((): boolean => {
    if (setupSteps.length === 0) return true;
    if (currentStep >= setupSteps.length) return !!instanceName.trim();
    
    const step = setupSteps[currentStep];
    
    switch (step.type) {
      case 'credential_profile':
      case 'composio_profile':
        const hasProfile = !!profileMappings[step.id];
        if (!hasProfile) return false;
        return true;
        
      case 'custom_server':
        const config = customMcpConfigs[step.qualified_name] || {};
        if (!step.required_config || step.required_config.length === 0) return true;
        return step.required_config.every(key => {
          const value = config[key];
          return value && value.toString().trim().length > 0;
        });
      default:
        return false;
    }
  }, [currentStep, setupSteps, profileMappings, customMcpConfigs, instanceName]);

  const handleNext = useCallback(() => {
    if (currentStep < setupSteps.length) {
      setCurrentStep(currentStep + 1);
    }
  }, [currentStep, setupSteps.length]);

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  }, [currentStep]);

  const areAllTriggerVariablesFilled = useCallback((): boolean => {
    if (Object.keys(missingTriggerVariables).length === 0) return true;
    
    for (const [triggerKey, triggerData] of Object.entries(missingTriggerVariables)) {
      const triggerVars = triggerVariables[triggerKey] || {};
      for (const varName of triggerData.variables) {
        if (!triggerVars[varName] || triggerVars[varName].trim() === '') {
          return false;
        }
      }
    }
    return true;
  }, [missingTriggerVariables, triggerVariables]);

  const handleInstall = useCallback(async () => {
    if (!item || !instanceName.trim()) return;
    
    console.log('Dialog handleInstall - triggerVariables:', triggerVariables);
    console.log('Dialog handleInstall - missingTriggerVariables:', missingTriggerVariables);
    
    // Validate trigger variables if they exist
    if (Object.keys(missingTriggerVariables).length > 0) {
      for (const [triggerKey, triggerData] of Object.entries(missingTriggerVariables)) {
        const triggerVars = triggerVariables[triggerKey] || {};
        for (const varName of triggerData.variables) {
          if (!triggerVars[varName] || triggerVars[varName].trim() === '') {
            toast.error(`Please provide all trigger variables for ${triggerData.trigger_name}`);
            return;
          }
        }
      }
    }
    
    const finalCustomConfigs = { ...customMcpConfigs };
    
    setupSteps.forEach(step => {
      if (step.type === 'composio_profile') {
        const profileId = profileMappings[step.id];
        if (profileId) {
          finalCustomConfigs[step.qualified_name] = {
            profile_id: profileId
          };
        }
      }
    });

    await onInstall(item, instanceName, profileMappings, finalCustomConfigs, triggerConfigs, triggerVariables);
  }, [item, instanceName, profileMappings, customMcpConfigs, triggerConfigs, triggerVariables, missingTriggerVariables, setupSteps, onInstall]);

  const currentStepData = setupSteps[currentStep];
  const isOnFinalStep = currentStep >= setupSteps.length;

  if (!item) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0">
              <AgentAvatar
                iconName={item.icon_name}
                iconColor={item.icon_color}
                backgroundColor={item.icon_background}
                agentName={item.name}
                size={48}
              />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-left flex items-center gap-2">
                Install {item.name}
              </DialogTitle>
              <DialogDescription className="text-left">
                {item.description}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="mt-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-sm">Preparing installation...</span>
              </div>
            </div>
          ) : (setupSteps.length === 0 || isOnFinalStep) ? (
            <div className="space-y-6">
              {Object.keys(missingTriggerVariables).length > 0 ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-orange-100 dark:bg-orange-900/20 flex items-center justify-center">
                      <Zap className="h-5 w-5 text-orange-600 dark:text-orange-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Customize Trigger Variables</h3>
                      <p className="text-sm text-muted-foreground">
                        This template has triggers with variables that need your values.
                      </p>
                    </div>
                  </div>
                  <TriggerVariablesStep
                    triggerVariables={missingTriggerVariables}
                    values={triggerVariables}
                    onValuesChange={(triggerKey, variables) => {
                      setTriggerVariables(prev => ({
                        ...prev,
                        [triggerKey]: variables
                      }));
                    }}
                  />
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-green-100 dark:bg-green-900/20 flex items-center justify-center">
                      <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold">Ready to install!</h3>
                      <p className="text-sm text-muted-foreground">
                        Give your agent a name and we'll set everything up.
                      </p>
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <Label htmlFor="instance-name">Agent Name</Label>
                <Input
                  id="instance-name"
                  placeholder="Enter a name for this agent"
                  value={instanceName}
                  onChange={handleInstanceNameChange}
                  className="h-11"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                    {currentStepData.source === 'trigger' ? (
                      <Zap className="h-4 w-4" />
                    ) : (
                      <Shield className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{currentStepData.title}</h3>
                      {currentStepData.source === 'trigger' && (
                        <Badge variant="secondary" className="text-xs text-white">
                          <Zap className="h-3 w-3" />
                          For Triggers
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {currentStepData.description}
                    </p>
                  </div>
                </div>
              </div>

              <div>
                {(currentStepData.type === 'credential_profile' || currentStepData.type === 'composio_profile') && (
                  <>
                    <ProfileConnector
                      step={currentStepData}
                      selectedProfileId={profileMappings[currentStepData.id]}
                      onProfileSelect={handleProfileSelect}
                      onComplete={() => {
                        if (currentStep < setupSteps.length - 1) {
                          setTimeout(() => setCurrentStep(currentStep + 1), 500);
                        }
                      }}
                    />
                    
                    {currentStepData.trigger_fields && profileMappings[currentStepData.id] && (
                      <div className="mt-4">
                        <TriggerConfigStep
                          step={currentStepData}
                          profileId={profileMappings[currentStepData.id]}
                          config={triggerConfigs[currentStepData.id] || {}}
                          onProfileSelect={handleProfileSelect}
                          onConfigUpdate={handleTriggerConfigUpdate}
                        />
                      </div>
                    )}
                  </>
                )}
                
                {currentStepData.type === 'custom_server' && (
                  <CustomServerStep
                    step={currentStepData}
                    config={customMcpConfigs[currentStepData.qualified_name] || {}}
                    onConfigUpdate={handleCustomConfigUpdate}
                  />
                )}
              </div>

              {setupSteps.length > 1 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    {setupSteps.map((_, index) => (
                      <div
                        key={index}
                        className={cn(
                          "h-1 flex-1 rounded-full transition-colors",
                          index <= currentStep ? 'bg-primary' : 'bg-muted'
                        )}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Step {currentStep + 1} of {setupSteps.length}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-3 pt-6 border-t">
          {currentStep > 0 && (
            <Button variant="outline" onClick={handleBack} className="flex-1">
              Back
            </Button>
          )}
          
          {isOnFinalStep ? (
            <Button 
              onClick={handleInstall}
              disabled={isInstalling || !instanceName.trim() || !areAllTriggerVariablesFilled()}
              className="flex-1"
            >
              {isInstalling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Install Agent
                </>
              )}
            </Button>
          ) : setupSteps.length === 0 ? (
            <Button 
              onClick={handleInstall}
              disabled={isInstalling || !instanceName.trim() || !areAllTriggerVariablesFilled()}
              className="flex-1"
            >
              {isInstalling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Installing...
                </>
              ) : (
                <>
                  <Download className="h-4 w-4" />
                  Install Agent
                </>
              )}
            </Button>
          ) : (
            <Button 
              onClick={handleNext}
              disabled={!isCurrentStepComplete()}
              className="flex-1"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}; 