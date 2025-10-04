import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { 
  Plus, 
  Loader2,
  Shield,
  Settings
} from 'lucide-react';
import { toast } from 'sonner';
import { ComposioCredentialProfileSelector } from '@/components/agents/composio/composio-credential-profile-selector';
import { ComposioConnector } from '@/components/agents/composio/composio-connector';
import { useCreateCredentialProfile, useCredentialProfiles, type CreateCredentialProfileRequest } from '@/hooks/react-query/mcp/use-credential-profiles';
import { useMCPServerDetails } from '@/hooks/react-query/mcp/use-mcp-servers';

import { useCredentialProfilesForMcp } from '@/hooks/react-query/mcp/use-credential-profiles';
import { useComposioToolkits } from '@/hooks/react-query/composio/use-composio';
import type { SetupStep } from './types';

interface ProfileConnectorProps {
  step: SetupStep;
  selectedProfileId: string | undefined;
  onProfileSelect: (qualifiedName: string, profileId: string | null) => void;
  onComplete?: () => void;
}

export const ProfileConnector: React.FC<ProfileConnectorProps> = ({
  step,
  selectedProfileId,
  onProfileSelect,
  onComplete
}) => {
  const [profileStep, setProfileStep] = useState<'select' | 'create'>('select');
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [showComposioConnector, setShowComposioConnector] = useState(false);

  const createProfileMutation = useCreateCredentialProfile();
  const { data: serverDetails } = useMCPServerDetails(
    step.qualified_name,
    !step.qualified_name?.startsWith('composio.')
  );
  
  const isComposioStep = step.type === 'composio_profile';
  
  const composioQualifiedName = React.useMemo(() => {
    if (!isComposioStep) return null;
    
    // Handle different cases:
    // 1. Generic 'composio' (from triggers) - use 'composio' as the qualified name
    // 2. Specific app like 'composio.gmail' - already formatted correctly
    // 3. App slug like 'gmail' - format as 'composio.gmail'
    if (step.qualified_name === 'composio') {
      return 'composio';
    } else if (step.qualified_name?.startsWith('composio.')) {
      return step.qualified_name;
    } else if (step.app_slug && step.app_slug !== 'composio') {
      return `composio.${step.app_slug}`;
    }
    return 'composio';
  }, [isComposioStep, step.app_slug, step.qualified_name]);
  
  const { data: composioProfiles } = useCredentialProfilesForMcp(composioQualifiedName);
  
  const { data: composioToolkits } = useComposioToolkits(
    isComposioStep && step.app_slug !== 'composio' ? step.app_slug : undefined,
    undefined
  );
  const configProperties = serverDetails?.connections?.[0]?.configSchema?.properties || {};
  const requiredFields = serverDetails?.connections?.[0]?.configSchema?.required || [];
  
  const hasConnectedComposioProfile = composioProfiles && composioProfiles.length > 0;

  useEffect(() => {
    setProfileStep('select');
    setIsCreatingProfile(false);
    setNewProfileName('');
    setConfig({});
    setShowComposioConnector(false);
  }, [step.qualified_name]);

  const mockComposioApp = useMemo(() => {
    const actualToolkit = composioToolkits?.toolkits?.find(t => t.slug === step.app_slug);
    return actualToolkit || {
      slug: step.app_slug || step.qualified_name,
      name: step.service_name,
      description: `Connect your ${step.service_name} account to use its tools`,
      logo: '',
      tags: [],
      auth_schemes: ['OAUTH2'],
      categories: []
    };
  }, [step.app_slug, step.qualified_name, step.service_name, composioToolkits]);

  const handleCreateProfile = useCallback(async () => {
    if (!newProfileName.trim()) {
      toast.error('Please enter a profile name');
      return;
    }

    setIsCreatingProfile(true);
    try {
      const request: CreateCredentialProfileRequest = {
        mcp_qualified_name: step.qualified_name,
        profile_name: newProfileName.trim(),
        display_name: step.service_name,
        config: config,
        is_default: false
      };

      const response = await createProfileMutation.mutateAsync(request);
      
      if (response.profile_id) {
        toast.success('Profile created successfully');
        // Use step.id instead of step.qualified_name to support trigger-specific profiles
        onProfileSelect(step.id, response.profile_id || 'new-profile');
        onComplete?.();
      }
    } catch (error) {
      console.error('Error creating profile:', error);
      toast.error('Failed to create profile');
    } finally {
      setIsCreatingProfile(false);
    }
  }, [newProfileName, config, step.id, step.qualified_name, step.service_name, createProfileMutation, onProfileSelect, onComplete]);

  const handleConfigChange = useCallback((key: string, value: string) => {
    setConfig(prev => ({
      ...prev,
      [key]: value
    }));
  }, []);

  const handleProfileNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewProfileName(e.target.value);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && profileStep === 'create') {
      handleCreateProfile();
    }
  }, [handleCreateProfile, profileStep]);

  const isFieldRequired = (fieldName: string) => {
    return requiredFields.includes(fieldName);
  };

    const SelectProfileStep = useMemo(() => (
    <div className="space-y-4">
      {isComposioStep ? (
        <div className="space-y-4">
          {hasConnectedComposioProfile ? (
            <ComposioCredentialProfileSelector
              toolkitSlug={step.app_slug || ''}
              toolkitName={step.service_name}
              selectedProfileId={selectedProfileId}
              onProfileSelect={(profileId) => {
                // Use step.id to support trigger-specific profiles
                onProfileSelect(step.id, profileId);
                if (profileId) {
                  onComplete?.();
                }
              }}
            />
          ) : (
            <div className="space-y-4">
              <Alert className="border-primary/20 bg-primary/5">
                <Shield className="h-4 w-4" />
                <AlertDescription>
                  No connected {step.service_name} profiles found. Create and connect one to continue.
                </AlertDescription>
              </Alert>
              
              <Button 
                onClick={() => setShowComposioConnector(true)}
                className="w-full"
              >
                <Plus className="h-4 w-4" />
                Connect {step.service_name}
              </Button>
            </div>
          )}

          {hasConnectedComposioProfile && (
            <>
              <div className="flex items-center gap-3">
                <Separator className="flex-1" />
                <span className="text-xs text-muted-foreground">OR</span>
                <Separator className="flex-1" />
              </div>

              <Button 
                variant="outline" 
                onClick={() => setShowComposioConnector(true)}
                className="w-full"
              >
                <Plus className="h-4 w-4" />
                Connect Different Account
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <Alert>
            <AlertDescription>
              MCP credential profile selection coming soon. For now, please use Composio integrations.
            </AlertDescription>
          </Alert>

          <Button 
            variant="outline" 
            onClick={() => {
              setNewProfileName(`${step.service_name} Profile`);
              setProfileStep('create');
            }}
            className="w-full"
          >
            <Plus className="h-4 w-4" />
            Create New Profile
          </Button>
        </div>
      )}
    </div>
  ), [
    step.service_name,
    step.qualified_name,
    step.app_slug,
    isComposioStep,
    selectedProfileId,
    hasConnectedComposioProfile,
    onProfileSelect,
    onComplete
  ]);

  const CreateProfileStep = useMemo(() => (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <Button 
            variant="link" 
            size="sm"
            onClick={() => setProfileStep('select')}
            className="mb-4 p-0 h-auto font-normal text-muted-foreground hover:text-foreground"
          >
            ← Back to Selection
          </Button>
        </div>
        <h3 className="font-semibold">Create {step.service_name} Profile</h3>
        <p className="text-sm text-muted-foreground">
          Set up a new credential profile for {step.service_name}
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="profile-name">Profile Name</Label>
          <Input
            id="profile-name"
            placeholder="e.g., Personal Account, Work Account"
            value={newProfileName}
            onChange={handleProfileNameChange}
            onKeyDown={handleKeyDown}
            autoFocus
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">
            This helps you identify different configurations
          </p>
        </div>

        {Object.keys(configProperties).length > 0 ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Settings className="h-4 w-4" />
              <span className="text-sm font-medium">Connection Settings</span>
            </div>
            {Object.entries(configProperties).map(([key, schema]: [string, any]) => (
              <div key={key} className="space-y-2">
                <Label htmlFor={key}>
                  {schema.title || key}
                  {isFieldRequired(key) && (
                    <span className="text-destructive ml-1">*</span>
                  )}
                </Label>
                <Input
                  id={key}
                  type={schema.format === 'password' ? 'password' : 'text'}
                  placeholder={schema.description || `Enter ${key}`}
                  value={config[key] || ''}
                  onChange={(e) => handleConfigChange(key, e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="h-11"
                />
                {schema.description && (
                  <p className="text-xs text-muted-foreground">{schema.description}</p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Alert className="border-primary/20 bg-primary/5">
            <Shield className="h-4 w-4" />
            <AlertDescription>
              This service doesn't require any credentials to connect.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div className="pt-4 border-t">
        <Button 
          onClick={handleCreateProfile}
          disabled={!newProfileName.trim() || isCreatingProfile}
          className="w-full"
        >
          {isCreatingProfile ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Create & Continue
            </>
          )}
        </Button>
      </div>
    </div>
  ), [
    step.service_name,
    newProfileName,
    config,
    configProperties,
    isCreatingProfile,
    handleProfileNameChange,
    handleKeyDown,
    handleConfigChange,
    handleCreateProfile,
    isFieldRequired
  ]);

  return (
    <>
      <div className="space-y-6">
        {profileStep === 'select' ? SelectProfileStep : CreateProfileStep}
      </div>

      {isComposioStep && (
        <ComposioConnector
          app={mockComposioApp}
          open={showComposioConnector}
          onOpenChange={setShowComposioConnector}
          mode="profile-only"
          onComplete={(profileId, appName, appSlug) => {
            // Use step.id to support trigger-specific profiles
            onProfileSelect(step.id, profileId);
            setShowComposioConnector(false);
            onComplete?.();
          }}
        />
      )}
    </>
  );
}; 