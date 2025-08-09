import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ArrowLeft, Check, AlertCircle, Plus, ExternalLink, ChevronRight, Search, Save, Loader2, User, Settings, Info } from 'lucide-react';
import { useCreateComposioProfile } from '@/hooks/react-query/composio/use-composio';
import { useComposioProfiles } from '@/hooks/react-query/composio/use-composio-profiles';
import { useComposioToolkitDetails } from '@/hooks/react-query/composio/use-composio';
import { ComposioToolsManager } from './composio-tools-manager';
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
    title: 'Select Profile',
    icon: <User className="h-4 w-4" />,
    showInProgress: true
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
    <div className="px-8 py-6">
      <div className="flex items-center justify-between relative">
        <div className="absolute left-0 right-0 top-[14px] h-[2px] bg-muted-foreground/20 -z-10" />
        <motion.div 
          className="absolute left-0 top-[14px] h-[2px] bg-primary -z-10"
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
              className="flex flex-col items-center gap-2 relative"
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: index * 0.1 }}
            >
              <div className="bg-background p-1 rounded-full">
                <div
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center transition-all duration-300 relative",
                    isCompleted && "bg-primary text-primary-foreground",
                    isCurrent && "bg-primary text-primary-foreground shadow-lg shadow-primary/25",
                    isUpcoming && "bg-muted-foreground/20 text-muted-foreground",
                    isCurrent && "ring-4 ring-primary/20"
                  )}
                >
                  {isCompleted ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <div className="h-3 w-3 flex items-center justify-center">
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

interface Tool {
  name: string;
  description: string;
  parameters: any;
}

const ToolCard = ({ tool, isSelected, onToggle, searchTerm }: {
  tool: Tool;
  isSelected: boolean;
  onToggle: () => void;
  searchTerm: string;
}) => {
  const highlightText = (text: string, term: string) => {
    if (!term) return text;
    const regex = new RegExp(`(${term})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) => 
      regex.test(part) ? <mark key={i} className="bg-yellow-200 dark:bg-yellow-900/50">{part}</mark> : part
    );
  };

  return (
    <Card className={cn(
      "group cursor-pointer transition-all p-0 shadow-none bg-card hover:bg-muted/50",
      isSelected && "bg-primary/10 ring-1 ring-primary/20"
    )}>
      <CardContent className="p-4" onClick={onToggle}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="font-medium text-sm truncate">
                {highlightText(tool.name, searchTerm)}
              </h3>
            </div>
            
            <p className="text-xs text-muted-foreground line-clamp-2">
              {highlightText(tool.description || 'No description available', searchTerm)}
            </p>
            
            {tool.parameters?.properties && (
              <div className="mt-2">
                <Badge variant="outline" className="text-xs">
                  {Object.keys(tool.parameters.properties).length} parameters
                </Badge>
              </div>
            )}
          </div>
          
          <div className="flex-shrink-0 ml-2">
            <Switch
              checked={isSelected}
              onCheckedChange={() => {}}
              onClick={(e) => e.stopPropagation()}
              className="data-[state=checked]:bg-primary"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

const ToolSkeleton = () => (
  <Card className="shadow-none p-0 bg-muted/30">
    <CardContent className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="h-6 w-11 rounded-full flex-shrink-0" />
      </div>
    </CardContent>
  </Card>
);

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

export const ComposioConnector: React.FC<ComposioConnectorProps> = ({
  app,
  open,
  onOpenChange,
  onComplete,
  mode = 'full',
  agentId
}) => {
  const [step, setStep] = useState<Step>(Step.ProfileSelect);
  const [profileName, setProfileName] = useState(`${app.name} Profile`);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [createdProfileId, setCreatedProfileId] = useState<string | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<ComposioProfile | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [showToolsManager, setShowToolsManager] = useState(false);
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  
  const [initiationFields, setInitiationFields] = useState<Record<string, string>>({});
  const [initiationFieldsErrors, setInitiationFieldsErrors] = useState<Record<string, string>>({});

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [isLoadingTools, setIsLoadingTools] = useState(false);
  const [isSavingTools, setIsSavingTools] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);

  const { mutate: createProfile, isPending: isCreating } = useCreateComposioProfile();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();
  
  const { data: toolkitDetails, isLoading: isLoadingToolkitDetails } = useComposioToolkitDetails(
    app.slug,
    { enabled: open && step === Step.ProfileCreate }
  );

  const existingProfiles = profiles?.filter(p => 
    p.toolkit_slug === app.slug && p.is_connected
  ) || [];

  const filteredTools = useMemo(() => {
    if (!searchTerm) return availableTools;
    const term = searchTerm.toLowerCase();
    return availableTools.filter(tool =>
      tool.name.toLowerCase().includes(term) ||
      (tool.description && tool.description.toLowerCase().includes(term))
    );
  }, [availableTools, searchTerm]);

  useEffect(() => {
    if (open) {
      setStep(mode === 'profile-only' ? Step.ProfileCreate : Step.ProfileSelect);
      setProfileName(`${app.name} Profile`);
      setSelectedProfileId('');
      setSelectedProfile(null);
      setCreatedProfileId(null);
      setRedirectUrl(null);
      setShowToolsManager(false);
      setDirection('forward');
      setSearchTerm('');
      setSelectedTools([]);
      setAvailableTools([]);
      setToolsError(null);
      setInitiationFields({});
      setInitiationFieldsErrors({});
    }
  }, [open, app.name, mode]);

  useEffect(() => {
    if (step === Step.ToolsSelection && selectedProfile) {
      loadTools();
      loadCurrentAgentTools();
    }
  }, [step, selectedProfile?.profile_id]);

  const loadTools = async () => {
    if (!selectedProfile) return;
    
    setIsLoadingTools(true);
    setToolsError(null);
    
    try {
      const response = await composioApi.discoverTools(selectedProfile.profile_id);
      if (response.success && response.tools) {
        setAvailableTools(response.tools);
      } else {
        setToolsError('Failed to load available tools');
      }
    } catch (err: any) {
      setToolsError(err.message || 'Failed to load tools');
    } finally {
      setIsLoadingTools(false);
    }
  };

  const loadCurrentAgentTools = async () => {
    if (!agentId || !selectedProfile) return;
    
    try {
      const response = await backendApi.get(`/agents/${agentId}`);
      if (response.success && response.data) {
        const agent = response.data;
        const composioMcps = agent.custom_mcps?.filter((mcp: any) => 
          mcp.type === 'composio' && mcp.config?.profile_id === selectedProfile?.profile_id
        ) || [];
        
        const enabledTools = composioMcps.flatMap((mcp: any) => mcp.enabledTools || []);
        setSelectedTools(enabledTools);
      }
    } catch (err) {
      console.error('Failed to load current agent tools:', err);
    }
  };

  const handleToolToggle = (toolName: string) => {
    setSelectedTools(prev => 
      prev.includes(toolName)
        ? prev.filter(t => t !== toolName)
        : [...prev, toolName]
    );
  };

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

  const handleSelectAll = () => {
    const allToolNames = filteredTools.map(tool => tool.name);
    setSelectedTools(prev => {
      const hasAll = allToolNames.every(name => prev.includes(name));
      if (hasAll) {
        return prev.filter(name => !allToolNames.includes(name));
      } else {
        const newSelected = [...prev];
        allToolNames.forEach(name => {
          if (!newSelected.includes(name)) {
            newSelected.push(name);
          }
        });
        return newSelected;
      }
    });
  };

  const handleSaveTools = async () => {
    if (!selectedProfile || !agentId) return;
    try {
      setIsSavingTools(true);
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
    } catch (error: any) {
      console.error('Failed to save tools:', error);
      toast.error(error.response?.data?.detail || 'Failed to save tools');
    } finally {
      setIsSavingTools(false);
    }
  };

  const navigateToStep = (newStep: Step) => {
    const currentIndex = getStepIndex(step);
    const newIndex = getStepIndex(newStep);
    setDirection(newIndex > currentIndex ? 'forward' : 'backward');
    setStep(newStep);
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
    
    if (!validateInitiationFields()) {
      toast.error('Please fill in all required fields');
      return;
    }
    
    createProfile({
      toolkit_slug: app.slug,
      profile_name: profileName,
      initiation_fields: Object.keys(initiationFields).length > 0 ? initiationFields : undefined,
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
    switch (step) {
      case Step.ProfileCreate:
        if (mode === 'profile-only') {
          onOpenChange(false);
        } else {
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

  if (showToolsManager && agentId && selectedProfile) {
    return (
      <ComposioToolsManager
        agentId={agentId}
        open={showToolsManager}
        onOpenChange={(open) => {
          if (!open) {
            handleToolsSave();
          }
          setShowToolsManager(open);
        }}
        profileId={selectedProfile.profile_id}
        profileInfo={{
          profile_id: selectedProfile.profile_id,
          profile_name: selectedProfile.profile_name,
          toolkit_name: selectedProfile.toolkit_name,
          toolkit_slug: selectedProfile.toolkit_slug,
        }}
        appLogo={app.logo}
        onToolsUpdate={() => {
          handleToolsSave();
        }}
      />
    );
  }

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

  const selectedCount = selectedTools.length;
  const filteredSelectedCount = filteredTools.filter(tool => selectedTools.includes(tool.name)).length;
  const allFilteredSelected = filteredTools.length > 0 && filteredSelectedCount === filteredTools.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(
        "overflow-hidden gap-0",
        step === Step.ToolsSelection ? "max-w-2xl h-[85vh] p-0 flex flex-col" : "max-w-lg p-0"
      )}>
        <StepIndicator currentStep={step} mode={mode} />
        
        {step !== Step.ToolsSelection ? (
          <>
            <DialogHeader className="px-8 pt-8 pb-2">
              <div className="flex items-center gap-4">
                {app.logo ? (
                  <img src={app.logo} alt={app.name} className="w-14 h-14 rounded-xl object-contain bg-muted p-2 border" />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary font-semibold shadow-sm">
                    {app.name.charAt(0)}
                  </div>
                )}
                <div className="flex-1">
                  <DialogTitle className="text-xl font-semibold">
                    {step === Step.Success ? 'Connection Complete' : `Connect ${app.name}`}
                  </DialogTitle>
                  <p className="text-sm text-muted-foreground">
                    {stepConfigs.find(config => config.id === step)?.description}
                  </p>
                  {app.description && (step === Step.ProfileSelect || step === Step.ProfileCreate) && (
                    <p className="text-xs text-muted-foreground/70 line-clamp-2">
                      {app.description}
                    </p>
                  )}
                </div>
              </div>
            </DialogHeader>
            <div className="px-8 pb-8 pt-6">
              <AnimatePresence mode="wait" custom={direction}>
                {step === Step.ProfileSelect && (
                  <motion.div
                    key="profile-select"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="space-y-6"
                  >
                    {existingProfiles.length > 0 && (
                      <div className="space-y-3">
                        <Label className="text-sm font-medium">Use Existing Profile</Label>
                        <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                          <SelectTrigger className="w-full h-12 text-base">
                            <SelectValue placeholder="Select a profile...">
                              {selectedProfileId && (() => {
                                const selectedProfile = existingProfiles.find(p => p.profile_id === selectedProfileId);
                                return selectedProfile ? (
                                  <div className="flex items-center gap-3">
                                    {app.logo ? (
                                      <img src={app.logo} alt={app.name} className="h-5 w-5 rounded-lg object-contain flex-shrink-0" />
                                    ) : (
                                      <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary text-xs font-semibold flex-shrink-0">
                                        {app.name.charAt(0)}
                                      </div>
                                    )}
                                    <span className="text-sm font-medium truncate">{selectedProfile.profile_name}</span>
                                  </div>
                                ) : null;
                              })()}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent className="w-full">
                            {existingProfiles.map((profile) => (
                              <SelectItem key={profile.profile_id} value={profile.profile_id}>
                                <div className="flex items-center gap-3 w-full">
                                  {app.logo ? (
                                    <img src={app.logo} alt={app.name} className="h-5 w-5 rounded-lg object-contain flex-shrink-0" />
                                  ) : (
                                    <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary text-xs font-semibold flex-shrink-0">
                                      {app.name.charAt(0)}
                                    </div>
                                  )}
                                  <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{profile.profile_name}</div>
                                    <div className="text-xs text-muted-foreground">
                                      Created {formatDistanceToNow(new Date(profile.created_at), { addSuffix: true })}
                                    </div>
                                  </div>
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="h-px bg-border flex-1" />
                        <span className="text-xs text-muted-foreground px-2">
                          {existingProfiles.length > 0 ? 'or' : ''}
                        </span>
                        <div className="h-px bg-border flex-1" />
                      </div>
                        <Button
                          onClick={() => navigateToStep(Step.ProfileCreate)}
                          variant={existingProfiles.length > 0 ? "outline" : "default"}
                          className="w-full"
                        >
                          {app.logo ? (
                            <img src={app.logo} alt={app.name} className="h-4 w-4 rounded-lg object-contain" />
                          ) : (
                            <div className="w-4 h-4 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-primary text-xs font-semibold mr-2">
                              {app.name.charAt(0)}
                            </div>
                          )}
                          Connect New {app.name} Account
                          <Plus className="h-4 w-4" />
                        </Button>
                    </div>
                    <div className="flex gap-3 pt-2">
                      <Button
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        className="flex-1"
                      >
                        Cancel
                      </Button>
                      {existingProfiles.length > 0 && (
                        <Button
                          onClick={handleProfileSelect}
                          disabled={!selectedProfileId}
                          className="flex-1"
                        >
                          {mode === 'full' && agentId ? 'Configure Tools' : 'Use Profile'}
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </motion.div>
                )}
                {step === Step.ProfileCreate && (
                  <motion.div
                    key="profile-create"
                    custom={direction}
                    variants={slideVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.3, ease: "easeInOut" }}
                    className="space-y-6"
                  >
                    <div className="space-y-3">
                      <Label htmlFor="profileName" className="text-sm font-medium">Profile Name</Label>
                      <Input
                        id="profileName"
                        value={profileName}
                        onChange={(e) => setProfileName(e.target.value)}
                        placeholder="Enter a name for this profile"
                        className="text-base"
                      />
                      <p className="text-xs text-muted-foreground">
                        Choose a memorable name to identify this connection
                      </p>
                    </div>
                    {isLoadingToolkitDetails && (
                      <div className="space-y-3">
                        <div className="text-sm text-muted-foreground">Loading connection requirements...</div>
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-24" />
                          <Skeleton className="h-10 w-full" />
                          <Skeleton className="h-3 w-3/4" />
                        </div>
                      </div>
                    )}
                    {!isLoadingToolkitDetails && toolkitDetails?.toolkit.connected_account_initiation_fields && (
                      <div className="space-y-4">
                        <div className="text-sm font-medium text-muted-foreground">
                          Connection Requirements
                        </div>
                        {(toolkitDetails.toolkit.connected_account_initiation_fields.required?.length ?? 0) > 0 && (
                          <div className="space-y-3">
                            {toolkitDetails.toolkit.connected_account_initiation_fields.required.map((field) => (
                              <InitiationFieldInput
                                key={field.name}
                                field={field}
                                value={initiationFields[field.name] || ''}
                                onChange={(value) => handleInitiationFieldChange(field.name, value)}
                                error={initiationFieldsErrors[field.name]}
                              />
                            ))}
                          </div>
                        )}
                        {(toolkitDetails.toolkit.connected_account_initiation_fields.optional?.length ?? 0) > 0 && (
                          <div className="space-y-3">
                            <div className="text-xs text-muted-foreground">Optional</div>
                            {toolkitDetails.toolkit.connected_account_initiation_fields.optional.map((field) => (
                              <InitiationFieldInput
                                key={field.name}
                                field={field}
                                value={initiationFields[field.name] || ''}
                                onChange={(value) => handleInitiationFieldChange(field.name, value)}
                                error={initiationFieldsErrors[field.name]}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="flex gap-3 pt-2">
                      <Button
                        variant="outline"
                        onClick={handleBack}
                        disabled={isCreating}
                        className="flex-1"
                      >
                        <ArrowLeft className="h-4 w-4" />
                        Back
                      </Button>
                      <Button
                        onClick={handleCreateProfile}
                        disabled={isCreating || isLoadingToolkitDetails || !profileName.trim()}
                        className="flex-1"
                      >
                        {isCreating ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Creating...
                          </>
                        ) : (
                          <>
                            Connect
                            <ChevronRight className="h-4 w-4" />
                          </>
                        )}
                      </Button>
                    </div>
                  </motion.div>
                )}
                {step === Step.Connecting && (
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
                {step === Step.Success && (
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
            <DialogHeader className="px-8 py-6 border-b border-border/50 flex-shrink-0 bg-muted/10">
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
              {step === Step.ToolsSelection && (
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
                  <div className="px-8 py-4 border-b border-border/50 bg-muted/10 flex-shrink-0">
                    <div className="flex items-center gap-4">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Search tools..."
                          value={searchTerm}
                          onChange={(e) => setSearchTerm(e.target.value)}
                          className="pl-10 h-10 bg-background/50 border-input/50 focus:bg-background"
                        />
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground whitespace-nowrap">
                          {filteredTools.length} {searchTerm && `of ${availableTools.length}`} tools
                        </span>
                        
                        {selectedCount > 0 && (
                          <Badge variant="secondary" className="bg-primary/10 text-primary border-0 px-2.5 h-7">
                            {selectedCount}
                          </Badge>
                        )}
                        {filteredTools.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleSelectAll}
                            className="h-9 px-4"
                          >
                            {allFilteredSelected ? 'Deselect' : 'Select'} All
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                  <ScrollArea className="flex-1 min-h-0">
                    <div className="p-8">
                      {toolsError && (
                        <Alert className="mb-6 bg-destructive/10 border-destructive/20">
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription>{toolsError}</AlertDescription>
                        </Alert>
                      )}
                      {isLoadingTools ? (
                        <div className="space-y-3">
                          {Array.from({ length: 6 }).map((_, i) => (
                            <ToolSkeleton key={i} />
                          ))}
                        </div>
                      ) : filteredTools.length > 0 ? (
                        <div className="space-y-3">
                          {filteredTools.map((tool) => (
                            <ToolCard
                              key={tool.name}
                              tool={tool}
                              isSelected={selectedTools.includes(tool.name)}
                              onToggle={() => handleToolToggle(tool.name)}
                              searchTerm={searchTerm}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="text-center py-16">
                          <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
                            <Search className="h-8 w-8 text-muted-foreground" />
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {searchTerm ? `No tools found matching "${searchTerm}"` : 'No tools available'}
                          </p>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                  <div className="px-8 py-6 border-t border-border/50 bg-muted/10 flex-shrink-0">
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-muted-foreground">
                        {selectedCount > 0 ? (
                          `${selectedCount} tool${selectedCount === 1 ? '' : 's'} will be added to your agent`
                        ) : (
                          'No tools selected'
                        )}
                      </div>
                      <div className="flex gap-3">
                        <Button
                          variant="outline"
                          onClick={handleBack}
                          disabled={isSavingTools}
                          className="px-6"
                        >
                          <ArrowLeft className="h-4 w-4" />
                          Back
                        </Button>
                        <Button
                          onClick={handleSaveTools}
                          disabled={isSavingTools || isLoadingTools}
                          className="px-8 min-w-[120px]"
                        >
                          {isSavingTools ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Saving...
                            </>
                          ) : (
                            <>
                              <Save className="h-4 w-4" />
                              Save Tools
                            </>
                          )}
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
