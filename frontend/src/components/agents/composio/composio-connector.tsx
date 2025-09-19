import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowLeft, Check, AlertCircle, Plus, ExternalLink, ChevronRight, Search, Save, Loader2, User, Settings, Info, Eye, Zap, Wrench, X, Shield } from 'lucide-react';
import { useCreateComposioProfile, useComposioTools, useCheckProfileNameAvailability } from '@/hooks/react-query/composio/use-composio';
import { useComposioProfiles } from '@/hooks/react-query/composio/use-composio-profiles';
import { useComposioToolkitDetails } from '@/hooks/react-query/composio/use-composio';
import type { ComposioToolkit, ComposioProfile, AuthConfigField } from '@/hooks/react-query/composio/utils';
import { toast } from 'sonner';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { backendApi } from '@/lib/api-client';
import { composioApi } from '@/hooks/react-query/composio/utils';
import { ComposioToolsSelector } from './composio-tools-selector';

interface ComposioConnectorProps {
  app: ComposioToolkit;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (profileId: string, appName: string, appSlug: string) => void;
  mode?: 'full' | 'profile-only';
  agentId?: string;
}

enum Step {
  ProfileSelect = 'profile-select',
  ProfileCreate = 'profile-create',
  Connecting = 'connecting',
  ToolsSelection = 'tools-selection',
  Success = 'success'
}

interface StepConfig {
  id: Step;
  title: string;
  description?: string;
  icon: React.ReactNode;
  showInProgress?: boolean;
}

const stepConfigs: StepConfig[] = [
  {
    id: Step.ProfileSelect,
    title: 'Connect & Preview',
    description: 'Choose profile and explore available tools',
    icon: <User className="w-4 h-4" />,
    showInProgress: true,
  },
  {
    id: Step.ProfileCreate,
    title: 'Create Profile',
    icon: <Plus className="h-4 w-4" />,
    showInProgress: true
  },
  {
    id: Step.Connecting,
    title: 'Authenticate',
    icon: <ExternalLink className="h-4 w-4" />,
    showInProgress: true
  },
  {
    id: Step.ToolsSelection,
    title: 'Select Tools',
    icon: <Settings className="h-4 w-4" />,
    showInProgress: true
  },
  {
    id: Step.Success,
    title: 'Complete',
    description: 'Successfully connected',
    icon: <Check className="h-4 w-4" />,
    showInProgress: false
  }
];

const getStepIndex = (step: Step): number => {
  return stepConfigs.findIndex(config => config.id === step);
};

const StepIndicator = ({ currentStep, mode }: { currentStep: Step; mode: 'full' | 'profile-only' }) => {
  const currentIndex = getStepIndex(currentStep);
  const visibleSteps = mode === 'profile-only'
    ? stepConfigs.filter(step => step.id !== Step.ToolsSelection && step.id !== Step.ProfileSelect)
    : stepConfigs;

  const visibleCurrentIndex = visibleSteps.findIndex(step => step.id === currentStep);

  return (
    <div className="px-6 py-3">
      <div className="flex items-center justify-between relative">
        <div className="absolute left-0 right-0 top-[10px] h-[1px] bg-muted-foreground/20 -z-10" />
        <motion.div
          className="absolute left-0 top-[10px] h-[1px] bg-primary -z-10"
          initial={{ width: 0 }}
          animate={{
            width: `${(visibleCurrentIndex / (visibleSteps.length - 1)) * 100}%`
          }}
          transition={{ duration: 0.5, ease: "easeInOut" }}
        />

        {visibleSteps.map((step, index) => {
          const stepIndex = getStepIndex(step.id);
          const isCompleted = stepIndex < currentIndex;
          const isCurrent = step.id === currentStep;
          const isUpcoming = stepIndex > currentIndex;

          return (
            <motion.div
              key={step.id}
              className="flex flex-col items-center gap-1 relative"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: index * 0.1 }}
            >
              <div className="bg-background p-0.5 rounded-full">
                <div
                  className={cn(
                    "w-5 h-5 rounded-full flex items-center justify-center transition-all duration-300 relative",
                    isCompleted && "bg-primary text-primary-foreground",
                    isCurrent && "bg-primary text-primary-foreground shadow-lg shadow-primary/25",
                    isUpcoming && "bg-muted-foreground/20 text-muted-foreground",
                    isCurrent && "ring-2 ring-primary/20"
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-2.5 w-2.5" />
                  ) : (
                    <div className="h-2.5 w-2.5 flex items-center justify-center">
                      {step.icon}
                    </div>
                  )}
                </div>
              </div>
              {/* <span className={cn(
                "text-[11px] font-medium transition-all duration-300 whitespace-nowrap absolute -bottom-5",
                isCompleted && "text-foreground",
                isCurrent && "text-primary font-semibold",
                isUpcoming && "text-muted-foreground"
              )}>
                {step.title}
              </span> */}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};



const InitiationFieldInput = ({ field, value, onChange, error }: {
  field: AuthConfigField;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) => {
  const getInputType = (fieldType: string) => {
    switch (fieldType.toLowerCase()) {
      case 'password':
        return 'password';
      case 'email':
        return 'email';
      case 'url':
        return 'url';
      case 'number':
      case 'double':
        return 'number';
      case 'boolean':
        return 'checkbox';
      default:
        return 'text';
    }
  };

  const inputType = getInputType(field.type);
  const isBooleanField = field.type.toLowerCase() === 'boolean';
  const isNumberField = field.type.toLowerCase() === 'number' || field.type.toLowerCase() === 'double';

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={field.name} className="text-sm font-medium">
          {field.displayName}
          {field.required && <span className="text-destructive ml-1">*</span>}
        </Label>
      </div>

      {isBooleanField ? (
        <div className="flex items-center space-x-2">
          <input
            type="checkbox"
            id={field.name}
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            className="h-4 w-4"
          />
          <Label htmlFor={field.name} className="text-sm text-muted-foreground">
            {field.description || `Enable ${field.displayName.toLowerCase()}`}
          </Label>
        </div>
      ) : (
        <Input
          id={field.name}
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.default || `Enter ${field.displayName.toLowerCase()}`}
          className={cn(error && "border-destructive focus:border-destructive")}
          step={isNumberField ? "any" : undefined}
        />
      )}

      {field.description && !isBooleanField && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <span>{field.description}</span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

import type { ComposioTool } from '@/hooks/react-query/composio/utils';

const CUSTOM_OAUTH_REQUIRED_APPS = [
  'zendesk',
];

const ToolPreviewCard = ({ tool, searchTerm }: {
  tool: ComposioTool;
  searchTerm: string;
}) => {
  const highlightText = (text: string, term: string) => {
    if (!term) return text;
    const regex = new RegExp(`(${term})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, index) =>
      regex.test(part) ?
        <mark key={index} className="bg-yellow-200 dark:bg-yellow-900 px-0.5">{part}</mark> :
        part
    );
  };

  // Generate icon based on tool name/category
  const getToolIcon = (toolName: string) => {
    const name = toolName.toLowerCase();
    if (name.includes('create') || name.includes('add') || name.includes('new')) {
      return <Plus className="w-3 h-3" />;
    }
    if (name.includes('get') || name.includes('fetch') || name.includes('read') || name.includes('view')) {
      return <Eye className="w-3 h-3" />;
    }
    if (name.includes('update') || name.includes('edit') || name.includes('modify')) {
      return <Settings className="w-3 h-3" />;
    }
    if (name.includes('send') || name.includes('post') || name.includes('message')) {
      return <ChevronRight className="w-3 h-3" />;
    }
    if (name.includes('search') || name.includes('find')) {
      return <Search className="w-3 h-3" />;
    }
    if (name.includes('user') || name.includes('profile') || name.includes('account')) {
      return <User className="w-3 h-3" />;
    }
    // Default to first letter of tool name
    return (
      <div className="w-3 h-3 rounded-sm bg-primary/10 flex items-center justify-center text-[8px] font-semibold text-primary">
        {toolName.charAt(0).toUpperCase()}
      </div>
    );
  };

  return (
    <div
      className="border rounded-md p-2 hover:bg-muted/30 transition-colors group cursor-pointer"
      title={tool.description} // Show full description on hover
    >
      <div className="flex items-center gap-2">
        <div className="flex-shrink-0">
          {getToolIcon(tool.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">{highlightText(tool.name, searchTerm)}</div>
          {tool.tags && tool.tags.length > 0 && (
            <div className="text-[10px] text-muted-foreground truncate">
              {tool.tags[0]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const ComposioConnector: React.FC<ComposioConnectorProps> = ({
  app,
  open,
  onOpenChange,
  onComplete,
  mode = 'full',
  agentId
}) => {
  const [currentStep, setCurrentStep] = useState<Step>(Step.ProfileSelect);
  const [profileName, setProfileName] = useState(`${app.name} Profile`);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [createdProfileId, setCreatedProfileId] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<ComposioProfile | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [showToolsManager, setShowToolsManager] = useState(false);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [selectedConnectionType, setSelectedConnectionType] = useState<'existing' | 'new' | null>(null);

  const [initiationFields, setInitiationFields] = useState<Record<string, string>>({});
  const [initiationFieldsErrors, setInitiationFieldsErrors] = useState<Record<string, string>>({});

  // Custom OAuth configuration state
  const [useCustomAuth, setUseCustomAuth] = useState(false);
  const [customAuthConfig, setCustomAuthConfig] = useState<Record<string, string>>({});
  const [customAuthConfigErrors, setCustomAuthConfigErrors] = useState<Record<string, string>>({});

  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  const { mutate: createProfile, isPending: isCreating } = useCreateComposioProfile();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();

  const { data: toolkitDetails, isLoading: isLoadingToolkitDetails } = useComposioToolkitDetails(
    app.slug,
    { enabled: open && currentStep === Step.ProfileCreate }
  );
  
  // Profile name availability checking
  const { data: nameAvailability, isLoading: isCheckingName } = useCheckProfileNameAvailability(
    app.slug,
    profileName,
    { 
      enabled: open && currentStep === Step.ProfileCreate && profileName.length > 0,
      debounceMs: 500 
    }
  );

  const existingProfiles = profiles?.filter(p =>
    p.toolkit_slug === app.slug && p.is_connected
  ) || [];



  const [toolsPreviewSearchTerm, setToolsPreviewSearchTerm] = useState('');
  const { data: toolsResponse, isLoading: isLoadingToolsPreview } = useComposioTools(
    app.slug,
    {
      enabled: open && currentStep === Step.ProfileSelect,
      limit: 50
    }
  );

  const availableToolsPreview = toolsResponse?.tools || [];

  useEffect(() => {
    if (open) {
      const requiresCustomAuth = CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug);
      setCurrentStep(mode === 'profile-only' ? Step.ProfileCreate : Step.ProfileSelect);
      setProfileName(`${app.name} Profile`);
      setSelectedProfileId('');
      setSelectedProfile(null);
      setCreatedProfileId(null);
      setRedirectUrl(null);
      setShowToolsManager(false);
      setDirection('forward');
      setSelectedConnectionType(null);
      setSelectedTools([]);
      setInitiationFields({});
      setInitiationFieldsErrors({});
      setUseCustomAuth(requiresCustomAuth);
      setCustomAuthConfig({});
      setCustomAuthConfigErrors({});
    }
  }, [open, app.name, app.slug, mode]);



  const handleInitiationFieldChange = (fieldName: string, value: string) => {
    setInitiationFields(prev => ({ ...prev, [fieldName]: value }));
    if (initiationFieldsErrors[fieldName]) {
      setInitiationFieldsErrors(prev => ({ ...prev, [fieldName]: '' }));
    }
  };

  const validateInitiationFields = (): boolean => {
    const newErrors: Record<string, string> = {};
    const initiationRequirements = toolkitDetails?.toolkit.connected_account_initiation_fields;

    if (initiationRequirements?.required) {
      for (const field of initiationRequirements.required) {
        if (field.required) {
          const value = initiationFields[field.name];
          const isEmpty = !value || value.trim() === '';

          if (field.type.toLowerCase() === 'boolean') {
            continue;
          }

          if ((field.type.toLowerCase() === 'number' || field.type.toLowerCase() === 'double') && value) {
            if (isNaN(Number(value))) {
              newErrors[field.name] = `${field.displayName} must be a valid number`;
              continue;
            }
          }

          if (isEmpty) {
            newErrors[field.name] = `${field.displayName} is required`;
          }
        }
      }
    }

    setInitiationFieldsErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleCustomAuthFieldChange = (fieldName: string, value: string) => {
    setCustomAuthConfig(prev => ({ ...prev, [fieldName]: value }));
    if (customAuthConfigErrors[fieldName]) {
      setCustomAuthConfigErrors(prev => ({ ...prev, [fieldName]: '' }));
    }
  };

  const validateCustomAuthFields = (): boolean => {
    if (!useCustomAuth) return true;
    
    const newErrors: Record<string, string> = {};
    const authConfigDetails = toolkitDetails?.toolkit.auth_config_details?.[0];
    const authConfigFields = authConfigDetails?.fields?.auth_config_creation;

    if (authConfigFields?.required) {
      for (const field of authConfigFields.required) {
        if (field.required) {
          const value = customAuthConfig[field.name];
          const isEmpty = !value || value.trim() === '';

          if (isEmpty) {
            newErrors[field.name] = `${field.displayName} is required`;
          }
        }
      }
    }

    setCustomAuthConfigErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSaveTools = async () => {
    if (!selectedProfile || !agentId) return;

    const mcpConfigResponse = await composioApi.getMcpConfigForProfile(selectedProfile.profile_id);
    const response = await backendApi.put(`/agents/${agentId}/custom-mcp-tools`, {
      custom_mcps: [{
        ...mcpConfigResponse.mcp_config,
        enabledTools: selectedTools
      }]
    });
    if (response.data.success) {
      toast.success(`Added ${selectedTools.length} ${selectedProfile.toolkit_name} tools to your agent!`);
      onComplete(selectedProfile.profile_id, app.name, app.slug);
      onOpenChange(false);
    }
  };

  const navigateToStep = (newStep: Step) => {
    const currentIndex = getStepIndex(currentStep);
    const newIndex = getStepIndex(newStep);
    setDirection(newIndex > currentIndex ? 'forward' : 'backward');
    if (newStep === Step.ProfileCreate) {
      const requiresCustomAuth = CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug);
      setInitiationFields({});
      setInitiationFieldsErrors({});
      setCustomAuthConfig({});
      setCustomAuthConfigErrors({});
      setUseCustomAuth(requiresCustomAuth);
      setProfileName(`${app.name} Profile`);
    }
    setCurrentStep(newStep);
  };

  const handleProfileSelect = () => {
    if (selectedProfileId === 'new') {
      navigateToStep(Step.ProfileCreate);
    } else if (selectedProfileId) {
      const profile = existingProfiles.find(p => p.profile_id === selectedProfileId);
      if (profile) {
        setSelectedProfile(profile);
        setCreatedProfileId(profile.profile_id);
        if (mode === 'full' && agentId) {
          navigateToStep(Step.ToolsSelection);
        } else {
          onComplete(profile.profile_id, app.name, app.slug);
          onOpenChange(false);
        }
      }
    }
  };

  const handleCreateProfile = () => {
    if (!profileName.trim()) {
      toast.error('Profile name is required');
      return;
    }

    if (nameAvailability && !nameAvailability.available) {
      toast.error('This profile name is already in use. Please choose a different name.');
      return;
    }

    if (!validateCustomAuthFields()) {
      toast.error('Please fill in all required OAuth configuration fields');
      return;
    }

    if (!validateInitiationFields()) {
      toast.error('Please fill in all required fields');
      return;
    }

    createProfile({
      toolkit_slug: app.slug,
      profile_name: profileName,
      initiation_fields: Object.keys(initiationFields).length > 0 ? initiationFields : undefined,
      custom_auth_config: useCustomAuth && Object.keys(customAuthConfig).length > 0 ? customAuthConfig : undefined,
      use_custom_auth: useCustomAuth,
    }, {
      onSuccess: (response) => {
        setCreatedProfileId(response.profile_id);
        if (response.redirect_url) {
          setRedirectUrl(response.redirect_url);
          navigateToStep(Step.Connecting);
          window.open(response.redirect_url, '_blank', 'width=600,height=700');
        } else {
          if (mode === 'full' && agentId) {
            const newProfile = {
              profile_id: response.profile_id,
              profile_name: profileName,
              toolkit_name: app.name,
              toolkit_slug: app.slug,
              is_connected: true,
              created_at: new Date().toISOString(),
              mcp_url: response.mcp_url || '',
              display_name: profileName,
              is_default: false
            };
            setSelectedProfile(newProfile);
            navigateToStep(Step.ToolsSelection);
          } else {
            navigateToStep(Step.Success);
            setTimeout(() => {
              onComplete(response.profile_id, app.name, app.slug);
              onOpenChange(false);
            }, 1500);
          }
        }
      },
      onError: (error: any) => {
        toast.error(error.message || 'Failed to create profile');
      }
    });
  };

  const handleAuthComplete = () => {
    if (createdProfileId && mode === 'full' && agentId) {
      const profile = existingProfiles.find(p => p.profile_id === createdProfileId) || {
        profile_id: createdProfileId,
        profile_name: profileName,
        toolkit_name: app.name,
        toolkit_slug: app.slug,
        is_connected: true,
        created_at: new Date().toISOString(),
        mcp_url: '',
        display_name: profileName,
        is_default: false
      };
      setSelectedProfile(profile);
      navigateToStep(Step.ToolsSelection);
    } else if (createdProfileId) {
      navigateToStep(Step.Success);
      setTimeout(() => {
        onComplete(createdProfileId, app.name, app.slug);
        onOpenChange(false);
      }, 1500);
    }
  };

  const handleToolsSave = () => {
    if (createdProfileId) {
      onComplete(createdProfileId, app.name, app.slug);
      onOpenChange(false);
    }
  };

  const handleBack = () => {
    switch (currentStep) {
      case Step.ProfileCreate:
        if (mode === 'profile-only') {
          onOpenChange(false);
        } else {
          const requiresCustomAuth = CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug);
          setInitiationFields({});
          setInitiationFieldsErrors({});
          setCustomAuthConfig({});
          setCustomAuthConfigErrors({});
          setUseCustomAuth(requiresCustomAuth);
          setProfileName(`${app.name} Profile`);
          navigateToStep(Step.ProfileSelect);
        }
        break;
      case Step.Connecting:
        navigateToStep(Step.ProfileCreate);
        break;
      case Step.ToolsSelection:
        navigateToStep(Step.ProfileSelect);
        break;
      default:
        break;
    }
  };

  const filteredToolsPreview = availableToolsPreview.filter(tool =>
    !toolsPreviewSearchTerm ||
    tool.name.toLowerCase().includes(toolsPreviewSearchTerm.toLowerCase()) ||
    tool.description.toLowerCase().includes(toolsPreviewSearchTerm.toLowerCase()) ||
    tool.tags?.some(tag => tag.toLowerCase().includes(toolsPreviewSearchTerm.toLowerCase()))
  );



  const slideVariants = {
    enter: (direction: 'forward' | 'backward') => ({
      x: direction === 'forward' ? 300 : -300,
      opacity: 0
    }),
    center: {
      x: 0,
      opacity: 1
    },
    exit: (direction: 'forward' | 'backward') => ({
      x: direction === 'forward' ? -300 : 300,
      opacity: 0
    })
  };



  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(
        "overflow-hidden gap-0",
        currentStep === Step.ToolsSelection ? "max-w-2xl h-[85vh] p-0 flex flex-col" :
          currentStep === Step.ProfileSelect ? "max-w-2xl p-0" : "max-w-lg p-0"
      )}>
        <StepIndicator currentStep={currentStep} mode={mode} />

        {currentStep !== Step.ToolsSelection ? (
          <>
            <DialogHeader className="px-6 pb-3">
              <div className="flex items-center gap-3">
                {app.logo ? (
                  <img src={app.logo} alt={app.name} className="w-10 h-10 rounded-lg object-contain bg-muted p-1.5 border" />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary font-semibold text-sm">
                    {app.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1">
                  <DialogTitle className="text-base font-semibold">
                    {stepConfigs.find(config => config.id === currentStep)?.title}
                  </DialogTitle>
                  <p className="text-xs text-muted-foreground">
                    {stepConfigs.find(config => config.id === currentStep)?.description}
                  </p>
                </div>
              </div>
            </DialogHeader>
            <div className={cn(
              "flex-1 overflow-hidden",
              currentStep === Step.ProfileSelect ? "px-0 pb-0 pt-0" : "px-8 pb-8 pt-6"
            )}>
              <AnimatePresence mode="wait" custom={direction}>
                {currentStep === Step.ProfileSelect && (
                  <motion.div
                    key="profile-select"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="flex flex-col h-full max-h-[500px]"
                  >
                    <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-primary/20 scrollbar-track-transparent">
                      <div className="p-6 space-y-6">
                        <div className="space-y-4">
                          <div className="flex items-center gap-3 mb-4">
                            {app.logo ? (
                              <img src={app.logo} alt={app.name} className="w-8 h-8 rounded-lg object-contain bg-muted p-1 border flex-shrink-0" />
                            ) : (
                              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary font-semibold text-sm flex-shrink-0">
                                {app.name.charAt(0)}
                              </div>
                            )}
                            <div className="flex-1">
                              <h4 className="font-medium text-foreground">Connect to {app.name}</h4>
                              <p className="text-xs text-muted-foreground">Choose an existing profile or create a new connection</p>
                            </div>
                            <Button variant="outline" size="sm" onClick={() => setShowToolsManager(!showToolsManager)}>
                              {showToolsManager ? 'Hide' : 'View'} Tools
                            </Button>
                          </div>

                          <div className="grid gap-3">
                            {existingProfiles.length > 0 && (
                              <Card
                                className={cn(
                                  "cursor-pointer p-0 transition-all",
                                  selectedConnectionType === 'existing' ? "border-primary bg-primary/5" : "border-border hover:border-border/80"
                                )}
                                onClick={() => {
                                  if (selectedConnectionType === 'existing') {
                                    setSelectedConnectionType(null);
                                    setSelectedProfileId('');
                                  } else {
                                    setSelectedConnectionType('existing');
                                    setSelectedProfileId(existingProfiles[0]?.profile_id || '');
                                  }
                                }}
                              >
                                <CardContent className='p-2'>
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <div className="w-10 h-10 rounded-xl bg-green-200 dark:bg-green-900/20 flex items-center justify-center">
                                        <Check className="w-5 h-5 text-green-600 dark:text-green-400" />
                                      </div>
                                      <div>
                                        <h5 className="font-medium text-sm">Use Existing Connection</h5>
                                        <p className="text-xs text-muted-foreground">{existingProfiles.length} profile{existingProfiles.length > 1 ? 's' : ''} already connected</p>
                                      </div>
                                    </div>
                                    <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", selectedConnectionType === 'existing' && "rotate-90")} />
                                  </div>
                                  <AnimatePresence>
                                    {selectedConnectionType === 'existing' && (
                                      <motion.div
                                        initial={{ height: 0, opacity: 0 }}
                                        animate={{ height: "auto", opacity: 1 }}
                                        exit={{ height: 0, opacity: 0 }}
                                        transition={{ duration: 0.2, ease: "easeInOut" }}
                                        className="overflow-hidden"
                                      >
                                        <div className="mt-3 pt-3 border-t border-border/50">
                                          <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                                            <SelectTrigger className="w-full h-10">
                                              <SelectValue placeholder="Select a profile..." />
                                            </SelectTrigger>
                                            <SelectContent>
                                              {existingProfiles.map((profile) => (
                                                <SelectItem key={profile.profile_id} value={profile.profile_id}>
                                                  <div className="flex items-center gap-3">
                                                    {app.logo ? (
                                                      <img src={app.logo} alt={app.name} className="w-5 h-5 rounded-lg object-contain bg-muted p-0.5 border flex-shrink-0" />
                                                    ) : (
                                                      <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary text-xs font-semibold flex-shrink-0">
                                                        {app.name.charAt(0)}
                                                      </div>
                                                    )}
                                                    <div>
                                                      <div className="text-sm font-medium">{profile.profile_name}</div>
                                                    </div>
                                                  </div>
                                                </SelectItem>
                                              ))}
                                            </SelectContent>
                                          </Select>
                                        </div>
                                      </motion.div>
                                    )}
                                  </AnimatePresence>
                                </CardContent>
                              </Card>
                            )}

                            <Card className={cn(
                              "cursor-pointer p-0 transition-all",
                              selectedConnectionType === 'new' ? "border-primary bg-primary/5" : "border-border hover:border-border/80"
                            )} onClick={() => {
                              if (selectedConnectionType === 'new') {
                                setSelectedConnectionType(null);
                                setSelectedProfileId('');
                              } else {
                                setSelectedConnectionType('new');
                                setSelectedProfileId('new');
                                // Clear all fields when selecting new connection to prevent stale data
                                const requiresCustomAuth = CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug);
                                setInitiationFields({});
                                setInitiationFieldsErrors({});
                                setCustomAuthConfig({});
                                setCustomAuthConfigErrors({});
                                setUseCustomAuth(requiresCustomAuth);
                                setProfileName(`${app.name} Profile`);
                              }
                            }}>
                              <CardContent className='p-2'>
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                                      <Plus className="w-5 h-5 text-primary" />
                                    </div>
                                    <div>
                                      <h5 className="font-medium text-sm">Create New Connection</h5>
                                      <p className="text-xs text-muted-foreground">Connect a new {app.name} account</p>
                                    </div>
                                  </div>
                                  <ChevronRight className="w-4 h-4 text-muted-foreground" />
                                </div>
                              </CardContent>
                            </Card>
                          </div>
                        </div>
                        <AnimatePresence>
                          {showToolsManager && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.3, ease: "easeInOut" }}
                              className="overflow-hidden"
                            >
                              <div className="space-y-3">
                                <ScrollArea className="h-[200px] border rounded-md bg-muted/10">
                                  <div className="p-2">
                                    {isLoadingToolsPreview ? (
                                      <div className="grid grid-cols-2 gap-1">
                                        {[...Array(8)].map((_, i) => (
                                          <div key={i} className="border rounded-md p-2 animate-pulse bg-background/50">
                                            <div className="h-2 bg-muted rounded w-3/4 mb-1"></div>
                                            <div className="h-2 bg-muted rounded w-1/2"></div>
                                          </div>
                                        ))}
                                      </div>
                                    ) : filteredToolsPreview.length > 0 ? (
                                      <div className="grid grid-cols-2 gap-1">
                                        {filteredToolsPreview.map((tool) => (
                                          <ToolPreviewCard
                                            key={tool.slug}
                                            tool={tool}
                                            searchTerm={toolsPreviewSearchTerm}
                                          />
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="text-center py-6 text-muted-foreground">
                                        <Search className="h-4 w-4 mx-auto mb-2" />
                                        <p className="text-xs">
                                          {toolsPreviewSearchTerm ? 'No matches' : 'No tools available'}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                </ScrollArea>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                    <div className="px-6 py-4 border-t border-border/50 bg-muted/20 flex-shrink-0">
                      <div className="flex items-center justify-between">
                        <div className="text-sm text-muted-foreground">
                          {selectedConnectionType === 'new' ? 'Ready to create new connection' :
                            selectedConnectionType === 'existing' && selectedProfileId ? 'Profile selected' :
                              selectedConnectionType === 'existing' ? 'Select a profile to continue' :
                                'Choose how you want to connect'}
                        </div>
                        <div className="flex gap-3">
                          <Button
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            className="px-6"
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => {
                              if (selectedConnectionType === 'new') {
                                navigateToStep(Step.ProfileCreate);
                              } else {
                                handleProfileSelect();
                              }
                            }}
                            disabled={!selectedConnectionType || (selectedConnectionType === 'existing' && !selectedProfileId)}
                            className="px-8 min-w-[120px]"
                          >
                            {selectedConnectionType === 'new' ? (
                              <>
                                Create Connection
                                <ChevronRight className="h-4 w-4 ml-1" />
                              </>
                            ) : selectedConnectionType === 'existing' && selectedProfileId ? (
                              <>
                                {mode === 'full' && agentId ? 'Configure Tools' : 'Use Profile'}
                                <ChevronRight className="h-4 w-4 ml-1" />
                              </>
                            ) : (
                              'Continue'
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
                {currentStep === Step.ProfileCreate && (
                  <motion.div
                    key="profile-create"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="flex flex-col h-full"
                  >
                    <div className="flex-1 overflow-y-auto">
                      <div className="space-y-3">
                        <div className="space-y-1.5">
                          <Label htmlFor="profileName" className="text-sm font-medium">
                            Profile Name
                          </Label>
                          <div className="relative">
                            <Input
                              id="profileName"
                              value={profileName}
                              onChange={(e) => setProfileName(e.target.value)}
                              placeholder={`e.g., ${app.name} Production`}
                              className={cn(
                                "pr-10 h-9",
                                nameAvailability && !nameAvailability.available && "border-destructive",
                                nameAvailability && nameAvailability.available && profileName.length > 0 && "border-green-500"
                              )}
                            />
                            <div className="absolute right-2 top-1/2 -translate-y-1/2">
                              {isCheckingName && profileName.length > 0 && (
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                              )}
                              {!isCheckingName && nameAvailability && profileName.length > 0 && (
                                <>
                                  {nameAvailability.available ? (
                                    <Check className="h-3.5 w-3.5 text-green-500" />
                                  ) : (
                                    <X className="h-3.5 w-3.5 text-destructive" />
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                          
                          {nameAvailability && !nameAvailability.available && (
                            <div className="space-y-1">
                              <p className="text-xs text-destructive">
                                This name is already in use
                              </p>
                              {nameAvailability.suggestions.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {nameAvailability.suggestions.map((suggestion) => (
                                    <button
                                      key={suggestion}
                                      type="button"
                                      onClick={() => setProfileName(suggestion)}
                                      className="text-xs px-2 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors"
                                    >
                                      {suggestion}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {nameAvailability && nameAvailability.available && profileName.length > 0 && (
                            <p className="text-xs text-green-600 dark:text-green-400">
                              Name available
                            </p>
                          )}
                        </div>

                        {!isLoadingToolkitDetails && 
                         toolkitDetails?.toolkit.connected_account_initiation_fields?.required?.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5">
                              <Settings className="h-3.5 w-3.5 text-muted-foreground" />
                              <Label className="text-sm font-medium">Connection Details</Label>
                            </div>
                            {toolkitDetails.toolkit.connected_account_initiation_fields.required.map((field) => {
                              const fieldType = field.type?.toLowerCase() || 'string';
                              const isBoolean = fieldType === 'boolean';
                              const isNumber = fieldType === 'number' || fieldType === 'double';
                              
                              return (
                                <div key={field.name} className="space-y-1">
                                  <Label htmlFor={field.name} className="text-xs">
                                    {field.displayName}
                                    {field.required && <span className="text-destructive ml-1">*</span>}
                                  </Label>
                                  
                                  {isBoolean ? (
                                    <div className="flex items-center space-x-2">
                                      <Switch
                                        id={field.name}
                                        checked={initiationFields[field.name] === 'true'}
                                        onCheckedChange={(checked) => 
                                          handleInitiationFieldChange(field.name, checked ? 'true' : 'false')
                                        }
                                      />
                                      <Label htmlFor={field.name} className="text-xs font-normal">
                                        {field.description || 'Enable'}
                                      </Label>
                                    </div>
                                  ) : (
                                    <>
                                      <Input
                                        id={field.name}
                                        type={fieldType === 'password' ? 'password' : 
                                              fieldType === 'email' ? 'email' :
                                              fieldType === 'url' ? 'url' :
                                              isNumber ? 'number' : 'text'}
                                        value={initiationFields[field.name] || ''}
                                        onChange={(e) => handleInitiationFieldChange(field.name, e.target.value)}
                                        placeholder={field.default || field.description || `Enter ${field.displayName.toLowerCase()}`}
                                        className={cn(
                                          "h-8",
                                          initiationFieldsErrors[field.name] && "border-destructive"
                                        )}
                                        step={isNumber ? "any" : undefined}
                                      />
                                      {field.description && !isBoolean && (
                                        <p className="text-[10px] text-muted-foreground">{field.description}</p>
                                      )}
                                    </>
                                  )}
                                  
                                  {initiationFieldsErrors[field.name] && (
                                    <p className="text-[10px] text-destructive">{initiationFieldsErrors[field.name]}</p>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {toolkitDetails?.toolkit.auth_config_details?.[0]?.fields?.auth_config_creation && (
                          <div className="space-y-3 border rounded-lg p-3">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <Shield className="h-3.5 w-3.5 text-primary" />
                                <div>
                                  <Label htmlFor="custom-auth" className="text-sm font-medium cursor-pointer">
                                    Custom OAuth App
                                    {CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug) && (
                                      <Badge variant="secondary" className="ml-2 text-xs">Required</Badge>
                                    )}
                                  </Label>
                                  <p className="text-xs text-muted-foreground">
                                    {CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug) 
                                      ? `${app.name} requires your own OAuth credentials`
                                      : 'Use your own OAuth credentials'
                                    }
                                  </p>
                                </div>
                              </div>
                              <Switch
                                id="custom-auth"
                                checked={useCustomAuth}
                                disabled={CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug)}
                                onCheckedChange={(checked) => {
                                  if (CUSTOM_OAUTH_REQUIRED_APPS.includes(app.slug)) return;
                                  setUseCustomAuth(checked);
                                  if (checked && toolkitDetails?.toolkit.auth_config_details?.[0]?.fields?.auth_config_creation?.optional) {
                                    const defaults: Record<string, string> = {};
                                    for (const field of toolkitDetails.toolkit.auth_config_details[0].fields.auth_config_creation.optional) {
                                      if (field.default) {
                                        defaults[field.name] = field.default;
                                      }
                                    }
                                    setCustomAuthConfig(prev => ({ ...prev, ...defaults }));
                                  }
                                }}
                              />
                            </div>
                              <AnimatePresence>
                                {useCustomAuth && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: "auto", opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="overflow-hidden"
                                  >
                                    <div className="space-y-2 pt-2 border-t">
                                      <div className="grid gap-2 sm:grid-cols-2">
                                        {toolkitDetails.toolkit.auth_config_details[0].fields.auth_config_creation.required?.map((field) => (
                                            <div key={field.name} className="space-y-1">
                                              <Label htmlFor={`auth-${field.name}`} className="text-xs">
                                                {field.displayName}
                                                <span className="text-destructive ml-1">*</span>
                                              </Label>
                                              <Input
                                                id={`auth-${field.name}`}
                                                type={field.name.includes('secret') ? 'password' : 'text'}
                                                value={customAuthConfig[field.name] || ''}
                                                onChange={(e) => handleCustomAuthFieldChange(field.name, e.target.value)}
                                                placeholder={`Enter ${field.displayName.toLowerCase()}`}
                                                className={cn(
                                                  "h-8 text-xs",
                                                  customAuthConfigErrors[field.name] && "border-destructive"
                                                )}
                                              />
                                              {customAuthConfigErrors[field.name] && (
                                                <p className="text-[10px] text-destructive">
                                                  {customAuthConfigErrors[field.name]}
                                                </p>
                                              )}
                                            </div>
                                        ))}
                                          {toolkitDetails.toolkit.auth_config_details[0].fields.auth_config_creation.optional
                                            ?.filter(field => !['bearer_token', 'access_token'].includes(field.name))
                                            .map((field) => (
                                              <div key={field.name} className={cn(
                                                "space-y-1",
                                                ['oauth_redirect_uri', 'scopes'].includes(field.name) ? 'sm:col-span-2' : ''
                                              )}>
                                                <Label htmlFor={`auth-opt-${field.name}`} className="text-xs">
                                                  {field.displayName}
                                                </Label>
                                                {field.name === 'oauth_redirect_uri' && field.default ? (
                                                  <div className="flex gap-1">
                                                    <Input
                                                      id={`auth-opt-${field.name}`}
                                                      value={field.default}
                                                      className="h-8 text-[10px] flex-1"
                                                      readOnly
                                                    />
                                                    <Button
                                                      type="button"
                                                      variant="outline"
                                                      size="sm"
                                                      className="h-8 px-2 text-xs"
                                                      onClick={() => {
                                                        navigator.clipboard.writeText(field.default || '');
                                                        toast.success('Copied!');
                                                      }}
                                                    >
                                                      Copy
                                                    </Button>
                                                  </div>
                                                ) : (
                                                  <Input
                                                    id={`auth-opt-${field.name}`}
                                                    type={field.name.includes('secret') ? 'password' : 'text'}
                                                    value={customAuthConfig[field.name] || field.default || ''}
                                                    onChange={(e) => handleCustomAuthFieldChange(field.name, e.target.value)}
                                                    placeholder={field.default || `Enter ${field.displayName.toLowerCase()}`}
                                                    className={cn(
                                                      "h-8 text-xs",
                                                      field.name === 'scopes' && "text-[10px]"
                                                    )}
                                                  />
                                                )}
                                                {field.description && (
                                                  <p className="text-[10px] text-muted-foreground">
                                                    {field.description}
                                                  </p>
                                                )}
                                              </div>
                                            ))}
                                      </div>
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                          </div>
                        )}

                        {/* Loading State */}
                        {isLoadingToolkitDetails && (
                          <div className="space-y-3">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-10 w-full" />
                            <Skeleton className="h-10 w-full" />
                          </div>
                        )}
                        </div>
                      </div>
                      <div className='mt-4'>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleBack}
                            disabled={isCreating}
                            className="flex-1 h-8"
                          >
                            <ArrowLeft className="h-3.5 w-3.5 mr-1" />
                            Back
                          </Button>
                          <Button
                            size="sm"
                            onClick={handleCreateProfile}
                            disabled={
                              isCreating || 
                              isLoadingToolkitDetails || 
                              !profileName.trim() ||
                              isCheckingName ||
                              (nameAvailability && !nameAvailability.available)
                            }
                            className="flex-1 h-8"
                          >
                            {isCreating ? (
                              <>
                                <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                                Creating...
                              </>
                            ) : (
                              <>
                                Connect
                                <ChevronRight className="h-3.5 w-3.5 ml-1" />
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                  </motion.div>
                )}
                {currentStep === Step.Connecting && (
                  <motion.div
                    key="connecting"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="space-y-6"
                  >
                    <div className="text-center space-y-6 py-8">
                      <div className="w-20 h-20 mx-auto border rounded-2xl bg-primary/10 flex items-center justify-center">
                        <ExternalLink className="h-10 w-10 text-primary animate-pulse" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="font-semibold text-lg">Complete Authentication</h3>
                        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                          A new window has opened for you to authorize your {app.name} connection.
                          Complete the process there and return here.
                        </p>
                      </div>
                    </div>
                    {redirectUrl && (
                      <Alert className="bg-muted/50 border-muted">
                        <AlertCircle className="h-4 w-4" />
                        <AlertDescription className="text-sm">
                          If the window didn't open,{' '}
                          <button
                            onClick={() => window.open(redirectUrl, '_blank')}
                            className="underline font-medium hover:no-underline"
                          >
                            click here to authenticate
                          </button>
                        </AlertDescription>
                      </Alert>
                    )}
                    <Button
                      onClick={handleAuthComplete}
                      className="w-full"
                    >
                      I've Completed Authentication
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </motion.div>
                )}
                {currentStep === Step.Success && (
                  <motion.div
                    key="success"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="text-center py-8"
                  >
                    <div className="space-y-6">
                      <div className="w-18 h-18 mx-auto rounded-full bg-green-400 dark:bg-green-600 flex items-center justify-center">
                        <Check className="h-10 w-10 text-white" />
                      </div>
                      <div className="space-y-1">
                        <h3 className="font-semibold text-lg">Successfully Connected!</h3>
                        <p className="text-sm text-muted-foreground">
                          Your {app.name} integration is ready.
                        </p>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="px-8 border-border/50 flex-shrink-0 bg-muted/10">
              <div className="flex items-center gap-4">
                {app.logo ? (
                  <img
                    src={app.logo}
                    alt={app.name}
                    className="w-14 h-14 rounded-xl object-contain bg-muted p-2 border"
                  />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary font-semibold shadow-sm">
                    {app.name.charAt(0) || 'T'}
                  </div>
                )}
                <div className="flex-1">
                  <DialogTitle className="text-xl font-semibold">
                    Configure {app.name} Tools
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    Select tools to add to your agent
                  </p>
                </div>
              </div>
            </DialogHeader>
            <AnimatePresence mode="wait" custom={direction}>
              {currentStep === Step.ToolsSelection && (
                <motion.div
                  key="tools-selection"
                  custom={direction}
                  variants={slideVariants}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  className="flex-1 flex flex-col min-h-0"
                >
                  {selectedProfile && (
                    <ComposioToolsSelector
                      profileId={selectedProfile.profile_id}
                      agentId={agentId}
                      toolkitName={selectedProfile.toolkit_name || app.name}
                      toolkitSlug={selectedProfile.toolkit_slug || app.slug}
                      selectedTools={selectedTools}
                      onToolsChange={setSelectedTools}
                      onSave={handleSaveTools}
                      showSaveButton={false}
                      className="flex-1 min-h-0"
                    />
                  )}
                  <div className="px-6 py-4 border-t bg-muted/20 flex-shrink-0">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-muted-foreground">
                        {selectedTools.length > 0 ? (
                          `${selectedTools.length} tool${selectedTools.length === 1 ? '' : 's'} will be added to your agent`
                        ) : (
                          'No tools selected'
                        )}
                      </div>
                      <div className="flex gap-3">
                        <Button
                          variant="outline"
                          onClick={handleBack}
                        >
                          <ArrowLeft className="h-4 w-4" />
                          Back
                        </Button>
                        <Button
                          onClick={handleSaveTools}
                          className="min-w-[80px]"
                        >
                          <Save className="h-4 w-4" />
                          Save Tools
                        </Button>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
