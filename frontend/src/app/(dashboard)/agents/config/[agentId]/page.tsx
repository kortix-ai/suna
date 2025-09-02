'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Play, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { useUpdateAgent } from '@/hooks/react-query/agents/use-agents';
import { useUpdateAgentMCPs } from '@/hooks/react-query/agents/use-update-agent-mcps';
import { useActivateAgentVersion } from '@/hooks/react-query/agents/use-agent-versions';

import { toast } from 'sonner';
import { useInitiateAgentWithInvalidation } from '@/hooks/react-query/dashboard/use-initiate-agent';
import { useThreadQuery } from '@/hooks/react-query/threads/use-threads';
import { ThreadComponent } from '@/components/thread/ThreadComponent';

import { useAgentVersionData } from '../../../../../hooks/use-agent-version-data';
import { useAgentVersionStore } from '../../../../../lib/stores/agent-version-store';

import { AgentHeader, VersionAlert, ConfigurationTab } from '@/components/agents/config';

import { DEFAULT_AGENTPRESS_TOOLS } from '@/components/agents/tools';
import { useExportAgent } from '@/hooks/react-query/agents/use-agent-export-import';
import { useAgentConfigTour } from '@/hooks/use-agent-config-tour';
import Joyride, { CallBackProps, STATUS, Step } from 'react-joyride';
import { TourConfirmationDialog } from '@/components/tour/TourConfirmationDialog';

const agentConfigTourSteps: Step[] = [
  {
    target: '[data-tour="agent-header"]',
    content: 'This is your agent\'s profile. You can edit the name and profile picture to personalize your agent.',
    title: 'Agent Profile',
    placement: 'bottom',
    disableBeacon: true,
  },
  {
    target: '[data-tour="model-section"]',
    content: 'Choose the AI model that powers your agent. Different models have different capabilities and pricing.',
    title: 'Model Configuration',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="system-prompt"]',
    content: 'Define how your agent behaves and responds. This is the core instruction that guides your agent\'s personality and capabilities.',
    title: 'System Prompt',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="tools-section"]',
    content: 'Configure the tools and capabilities your agent can use. Enable browser automation, web development, and more.',
    title: 'Agent Tools',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="integrations-section"]',
    content: 'Connect your agent to external services. Add integrations to extend your agent\'s capabilities.',
    title: 'Integrations',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="knowledge-section"]',
    content: 'Add knowledge to your agent to provide it with context and information.',
    title: 'Knowledge Base',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="playbooks-section"]',
    content: 'Add playbooks to your agent to help it perform tasks and automate workflows.',
    title: 'Playbooks',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="triggers-section"]',
    content: 'Set up automated triggers for your agent to run on schedules or events.',
    title: 'Triggers & Automation',
    placement: 'right',
    disableBeacon: true,
  },
  {
    target: '[data-tour="preview-agent"]',
    content: 'Build and test your agent by previewing how it will behave and respond. Here you can also ask the agent to self-configure',
    title: 'Build & Test Your Agent',
    placement: 'left',
    disableBeacon: true,
  },
];

interface FormData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  agentpress_tools: any;
  configured_mcps: any[];
  custom_mcps: any[];
  is_default: boolean;
  profile_image_url?: string;
  icon_name?: string | null;
  icon_color: string;
  icon_background: string;
}

function AgentConfigurationContent() {
  const params = useParams();
  const agentId = params.agentId as string;
  const router = useRouter();

  const { agent, versionData, isViewingOldVersion, isLoading, error } = useAgentVersionData({ agentId });
  const searchParams = useSearchParams();
  const initialAccordion = searchParams.get('accordion');
  const { setHasUnsavedChanges } = useAgentVersionStore();
  
  const updateAgentMutation = useUpdateAgent();
  const updateAgentMCPsMutation = useUpdateAgentMCPs();
  const activateVersionMutation = useActivateAgentVersion();
  const exportMutation = useExportAgent();

  // Use refs for stable references to avoid callback recreation
  const agentIdRef = useRef(agentId);
  const mutationsRef = useRef({
    updateAgent: updateAgentMutation,
    updateMCPs: updateAgentMCPsMutation,
    export: exportMutation,
    activate: activateVersionMutation,
  });

  // Update refs when values change
  useEffect(() => {
    agentIdRef.current = agentId;
    mutationsRef.current = {
      updateAgent: updateAgentMutation,
      updateMCPs: updateAgentMCPsMutation,
      export: exportMutation,
      activate: activateVersionMutation,
    };
  }, [agentId, updateAgentMutation, updateAgentMCPsMutation, exportMutation, activateVersionMutation]);

  const [formData, setFormData] = useState<FormData>({
    name: '',
    description: '',
    system_prompt: '',
    model: undefined,
    agentpress_tools: DEFAULT_AGENTPRESS_TOOLS,
    configured_mcps: [],
    custom_mcps: [],
    is_default: false,
    profile_image_url: '',
    icon_name: null,
    icon_color: '#000000',
    icon_background: '#e5e5e5',
  });

  const [originalData, setOriginalData] = useState<FormData>(formData);

  const [testThreadId, setTestThreadId] = useState<string | null>(null);
  const [testProjectId, setTestProjectId] = useState<string | null>(null);
  const [lastLoadedVersionId, setLastLoadedVersionId] = useState<string | null>(null);

  const initiateAgentMutation = useInitiateAgentWithInvalidation();

  // Query thread data to get project ID when we have a test thread  
  const { data: testThreadData } = useThreadQuery(testThreadId || '');

  // Update project ID when thread data loads and navigate if in test mode
  useEffect(() => {
    if (testThreadData?.project_id && testThreadId && !testProjectId) {
      setTestProjectId(testThreadData.project_id);
      
      // Save to localStorage
      localStorage.setItem(`agent-test-thread-${agentId}`, JSON.stringify({
        threadId: testThreadId,
        projectId: testThreadData.project_id
      }));

      // If we're in test mode, we already have the data to render
      // No need to navigate
    }
  }, [testThreadData, testThreadId, testProjectId, agentId]);

  // Load test thread from localStorage on mount
  useEffect(() => {
    const savedTestThread = localStorage.getItem(`agent-test-thread-${agentId}`);
    if (savedTestThread) {
      try {
        const { threadId, projectId } = JSON.parse(savedTestThread);
        setTestThreadId(threadId);
        setTestProjectId(projectId);
      } catch (error) {
        console.error('Failed to parse saved test thread:', error);
        localStorage.removeItem(`agent-test-thread-${agentId}`);
      }
    }
  }, [agentId]);

  // Create or load test thread
  const handleStartTestMode = async () => {
    if (testThreadId && testProjectId) {
      // Use existing test thread
      return;
    }

    // Create new test thread
    try {
      const formData = new FormData();
      formData.append('prompt', `Test conversation with ${agent?.name || 'agent'}`);
      formData.append('agent_id', agentId);

      const result = await initiateAgentMutation.mutateAsync(formData);
      
      if (result.thread_id) {
        setTestThreadId(result.thread_id);
      }
    } catch (error) {
      console.error('Failed to create test thread:', error);
      toast.error('Failed to create test thread');
    }
  };

  // Start a completely new test session - just reset to show prompt selection
  const handleStartNewTask = () => {
    // Clear existing test session from localStorage
    localStorage.removeItem(`agent-test-thread-${agentId}`);
    
    // Reset state to show the initial prompt selection screen
    setTestThreadId(null);
    setTestProjectId(null);
  };

  // Start test with a specific prompt
  const handleStartTestWithPrompt = async (prompt: string) => {
    try {
      // Clear existing test session from localStorage
      localStorage.removeItem(`agent-test-thread-${agentId}`);
      
      // Reset state
      setTestThreadId(null);
      setTestProjectId(null);
      
      // Create new test thread with the specific prompt
      const formData = new FormData();
      formData.append('prompt', prompt);
      formData.append('agent_id', agentId);

      const result = await initiateAgentMutation.mutateAsync(formData);
      
      if (result.thread_id) {
        setTestThreadId(result.thread_id);
      }
    } catch (error) {
      console.error('Failed to create test thread with prompt:', error);
      toast.error('Failed to start test conversation');
    }
  };

  useEffect(() => {
    if (!agent) return;
    
    const currentVersionId = versionData?.version_id || agent.current_version_id || 'current';
    const shouldResetForm = !lastLoadedVersionId || lastLoadedVersionId !== currentVersionId;
    
    if (!shouldResetForm) {
      setLastLoadedVersionId(currentVersionId);
      return;
    }
    
    let configSource = agent;
    if (versionData) {
      configSource = {
        ...agent,
        ...versionData,
        system_prompt: versionData.system_prompt,
        model: versionData.model,
        configured_mcps: versionData.configured_mcps,
        custom_mcps: versionData.custom_mcps,
        agentpress_tools: versionData.agentpress_tools,
        icon_name: versionData.icon_name || agent.icon_name,
        icon_color: versionData.icon_color || agent.icon_color,
        icon_background: versionData.icon_background || agent.icon_background,
      };
    }
    const newFormData: FormData = {
      name: configSource.name || '',
      description: configSource.description || '',
      system_prompt: configSource.system_prompt || '',
      model: configSource.model,
      agentpress_tools: configSource.agentpress_tools || DEFAULT_AGENTPRESS_TOOLS,
      configured_mcps: configSource.configured_mcps || [],
      custom_mcps: configSource.custom_mcps || [],
      is_default: configSource.is_default || false,
      profile_image_url: configSource.profile_image_url || '',
      icon_name: configSource.icon_name || null,
      icon_color: configSource.icon_color || '#000000',
      icon_background: configSource.icon_background || '#e5e5e5',
    };
    setFormData(newFormData);
    setOriginalData(newFormData);
    setLastLoadedVersionId(currentVersionId);
  }, [agent, versionData, lastLoadedVersionId]);

  const displayData = isViewingOldVersion && versionData ? {
    name: formData.name,
    description: formData.description,
    system_prompt: versionData.system_prompt || formData.system_prompt,
    model: versionData.model || formData.model,
    agentpress_tools: versionData.agentpress_tools || formData.agentpress_tools,
    configured_mcps: versionData.configured_mcps || formData.configured_mcps,
    custom_mcps: versionData.custom_mcps || formData.custom_mcps,
    is_default: formData.is_default,
    profile_image_url: formData.profile_image_url,
    icon_name: versionData.icon_name || formData.icon_name || null,
    icon_color: versionData.icon_color || formData.icon_color || '#000000',
    icon_background: versionData.icon_background || formData.icon_background || '#e5e5e5',
  } : formData;

  const handleFieldChange = (field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleMCPChange = useCallback((updates: { configured_mcps: any[]; custom_mcps: any[] }) => {
    const previousConfigured = formData.configured_mcps;
    const previousCustom = formData.custom_mcps;

    setFormData(prev => ({
      ...prev,
      configured_mcps: updates.configured_mcps || [],
      custom_mcps: updates.custom_mcps || []
    }));

    mutationsRef.current.updateMCPs.mutate({
      agentId: agentIdRef.current,
      configured_mcps: updates.configured_mcps || [],
      custom_mcps: updates.custom_mcps || [],
      replace_mcps: true
    }, {
      onSuccess: () => {
        setOriginalData(prev => ({
          ...prev,
          configured_mcps: updates.configured_mcps || [],
          custom_mcps: updates.custom_mcps || []
        }));
        toast.success('MCP configuration updated');
      },
      onError: (error) => {
        setFormData(prev => ({
          ...prev,
          configured_mcps: previousConfigured,
          custom_mcps: previousCustom
        }));
        toast.error('Failed to update MCP configuration');
        console.error('MCP update error:', error);
      }
    });
  }, []);

  const saveField = useCallback(async (fieldData: Partial<FormData>) => {
    try {
      await mutationsRef.current.updateAgent.mutateAsync({
        agentId: agentIdRef.current,
        ...fieldData,
      });
      
      setFormData(prev => ({ ...prev, ...fieldData }));
      setOriginalData(prev => ({ ...prev, ...fieldData }));
      return true;
    } catch (error) {
      console.error('Failed to save field:', error);
      throw error;
    }
  }, []);

  const handleNameSave = async (name: string) => {
    try {
      await saveField({ name });
      toast.success('Agent name updated');
    } catch {
      toast.error('Failed to update agent name');
      throw new Error('Failed to update agent name');
    }
  };

  const handleProfileImageSave = async (profileImageUrl: string | null) => {
    try {
      await saveField({ profile_image_url: profileImageUrl || '' });
    } catch {
      toast.error('Failed to update profile picture');
      throw new Error('Failed to update profile picture');
    }
  };
  
  const handleIconSave = async (iconName: string | null, iconColor: string, iconBackground: string) => {
    try {
      await saveField({ icon_name: iconName, icon_color: iconColor, icon_background: iconBackground });
      toast.success('Agent icon updated');
    } catch {
      toast.error('Failed to update agent icon');
      throw new Error('Failed to update agent icon');
    }
  };

  const handleSystemPromptSave = async (system_prompt: string) => {
    try {
      await saveField({ system_prompt });
      toast.success('System prompt updated');
    } catch {
      toast.error('Failed to update system prompt');
      throw new Error('Failed to update system prompt');
    }
  };

  const handleModelSave = async (model: string) => {
    try {
      await saveField({ model });
      toast.success('Model updated');
    } catch {
      toast.error('Failed to update model');
      throw new Error('Failed to update model');
    }
  };

  const handleToolsSave = async (agentpress_tools: Record<string, boolean | { enabled: boolean; description: string }>) => {
    try {
      await saveField({ agentpress_tools });
      toast.success('Tools updated');
    } catch {
      toast.error('Failed to update tools');
      throw new Error('Failed to update tools');
    }
  };

  const handleExport = () => {
    mutationsRef.current.export.mutate(agentIdRef.current);
  };

  const { hasUnsavedChanges } = React.useMemo(() => {
    const formDataStr = JSON.stringify(formData);
    const originalDataStr = JSON.stringify(originalData);
    const hasChanges = formDataStr !== originalDataStr;
    const isCurrent = !isViewingOldVersion;
    
    return {
      hasUnsavedChanges: hasChanges && isCurrent
    };
  }, [formData, originalData, isViewingOldVersion]);

  const prevHasUnsavedChangesRef = useRef(hasUnsavedChanges);
  useEffect(() => {
    if (prevHasUnsavedChangesRef.current !== hasUnsavedChanges) {
      prevHasUnsavedChangesRef.current = hasUnsavedChanges;
      setHasUnsavedChanges(hasUnsavedChanges);
    }
  }, [hasUnsavedChanges]);

  const handleActivateVersion = async (versionId: string) => {
    try {
      await mutationsRef.current.activate.mutateAsync({ agentId: agentIdRef.current, versionId });
      router.push(`/agents/config/${agentIdRef.current}`);
    } catch (error) {
      console.error('Failed to activate version:', error);
    }
  };

  // OPTIMIZED: Simplified save with stable reference
  const handleSave = useCallback(async () => {
    const currentFormData = formData;
    const hasChanges = JSON.stringify(currentFormData) !== JSON.stringify(originalData);
    
    if (hasChanges) {
      try {
        await mutationsRef.current.updateAgent.mutateAsync({
          agentId: agentIdRef.current,
          ...currentFormData,
        });
        
        setOriginalData(currentFormData);
        toast.success('Agent updated successfully');
      } catch (error) {
        toast.error('Failed to update agent');
        console.error('Failed to save agent:', error);
      }
    }
  }, []); // Using snapshot of formData in function instead of dependency

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Alert className="max-w-md">
          <AlertDescription>
            Failed to load agent: {error.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Alert className="max-w-md">
          <AlertDescription>
            Agent not found
          </AlertDescription>
        </Alert>
      </div>
    );
  }



  return (
    <div className="h-screen flex flex-col bg-background relative">

      <div className="flex-1 flex overflow-hidden">
        <div className="hidden lg:grid lg:grid-cols-2 w-full h-full">
          <div className="bg-background h-full flex flex-col border-r border-border/40 overflow-hidden">
            <div className="flex-shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="pt-4">
                {isViewingOldVersion && (
                  <div className="mb-4 px-8">
                    <VersionAlert
                      versionData={versionData}
                      isActivating={activateVersionMutation.isPending}
                      onActivateVersion={handleActivateVersion}
                    />
                  </div>
                )}
                <div data-tour="agent-header">
                  <AgentHeader
                    agentId={agentId}
                    displayData={displayData}
                    isViewingOldVersion={isViewingOldVersion}
                    onFieldChange={handleFieldChange}
                    onExport={handleExport}
                    isExporting={exportMutation.isPending}
                    agentMetadata={agent?.metadata}
                    currentVersionId={agent?.current_version_id}
                    currentFormData={{
                      system_prompt: formData.system_prompt,
                      configured_mcps: formData.configured_mcps,
                      custom_mcps: formData.custom_mcps,
                      agentpress_tools: formData.agentpress_tools
                    }}
                    hasUnsavedChanges={hasUnsavedChanges}
                    onVersionCreated={() => {
                      setOriginalData(formData);
                    }}
                    onNameSave={handleNameSave}
                    onProfileImageSave={handleProfileImageSave}
                    onIconSave={handleIconSave}
                  />
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="h-full">
                <ConfigurationTab
                  agentId={agentId}
                  displayData={displayData}
                  versionData={versionData}
                  isViewingOldVersion={isViewingOldVersion}
                  onFieldChange={handleFieldChange}
                  onMCPChange={handleMCPChange}
                  onSystemPromptSave={handleSystemPromptSave}
                  onModelSave={handleModelSave}
                  onToolsSave={handleToolsSave}
                  initialAccordion={initialAccordion}
                  agentMetadata={agent?.metadata}
                  isLoading={updateAgentMutation.isPending}
                />
              </div>
            </div>
          </div>
          
          <div className="bg-background h-full flex flex-col overflow-hidden" data-tour="preview-agent">
            {/* Thread Header */}
            <div className="flex-shrink-0 p-4 border-b border-border/20">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">Run "{agent?.name || 'Agent'}"</h3>
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  {!testThreadId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleStartTestMode}
                      disabled={initiateAgentMutation.isPending}
                      className="flex items-center gap-2"
                    >
                      {initiateAgentMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      Start
                    </Button>
                  )}
                  {testThreadId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleStartNewTask}
                      disabled={initiateAgentMutation.isPending}
                      className="flex items-center gap-2"
                    >
                      <Plus className="h-4 w-4" />
                      New Task
                    </Button>
                  )}
                </div>
              </div>
            </div>
            
            {/* Thread Content */}
            <div className="flex-1 overflow-hidden relative">
              {testThreadId && testProjectId ? (
                <ThreadComponent 
                  projectId={testProjectId}
                  threadId={testThreadId}
                  compact={true}
                  configuredAgentId={agentId}
                />
              ) : testThreadId && !testProjectId ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center space-y-4">
                    <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                    <div className="space-y-2">
                      <h3 className="text-lg font-medium">Initiating thread</h3>
                      <p className="text-sm text-muted-foreground">
                        Preparing your conversation...
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center space-y-6 max-w-md mx-auto px-4">
                    <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto">
                      <Play className="h-8 w-8 text-muted-foreground" />
                    </div>
                    
                    <div className="space-y-2">
                      <h3 className="text-lg font-medium">Ready to run</h3>
                      <p className="text-sm text-muted-foreground">
                        Start a conversation with your agent
                      </p>
                    </div>

                    <div className="space-y-3">
                      <Button
                        onClick={handleStartTestMode}
                        disabled={initiateAgentMutation.isPending}
                        className="w-full"
                        size="sm"
                      >
                        {initiateAgentMutation.isPending ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin mr-2" />
                            Starting...
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 mr-2" />
                            Start
                          </>
                        )}
                      </Button>

                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          Or try a suggested prompt:
                        </p>
                        
                        <div className="space-y-2">
                          <button
                            onClick={() => handleStartTestWithPrompt("Enter agent builder mode. Help me configure you to be my perfect agent. Ask me detailed questions about what I want you to do, how you should behave, what tools you need, and what knowledge would be helpful. Then suggest improvements to your system prompt, tools, and configuration.")}
                            disabled={initiateAgentMutation.isPending}
                            className="w-full text-left p-2 rounded-xl border border-border hover:bg-accent text-xs transition-colors"
                          >
                            <span className="font-medium">Agent Builder Mode</span>
                            <br />
                            <span className="text-muted-foreground">Help configure the perfect agent</span>
                          </button>

                          <button
                            onClick={() => handleStartTestWithPrompt("Hi! I want to test your capabilities. Can you tell me who you are, what you can do, and what tools and knowledge you have access to? Then let's do a quick test to see how well you work.")}
                            disabled={initiateAgentMutation.isPending}
                            className="w-full text-left p-2 rounded-xl border border-border hover:bg-accent text-xs transition-colors"
                          >
                            <span className="font-medium">Capability Test</span>
                            <br />
                            <span className="text-muted-foreground">Test what your agent can do</span>
                          </button>

                          <button
                            onClick={() => handleStartTestWithPrompt("I need help with a specific task. Let me explain what I'm trying to accomplish and you can guide me through the process step by step.")}
                            disabled={initiateAgentMutation.isPending}
                            className="w-full text-left p-2 rounded-xl border border-border hover:bg-accent text-xs transition-colors"
                          >
                            <span className="font-medium">Task-Based Run</span>
                            <br />
                            <span className="text-muted-foreground">Start with a real task</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:hidden w-full h-full">
          <div className="bg-background h-full flex flex-col overflow-hidden">
            <div className="flex-shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
              <div className="pt-4">
                
                {isViewingOldVersion && (
                  <div className="mb-4 px-4">
                    <VersionAlert
                      versionData={versionData}
                      isActivating={activateVersionMutation.isPending}
                      onActivateVersion={handleActivateVersion}
                    />
                  </div>
                )}
                
                <div className="flex items-center justify-between px-4">
                  <AgentHeader
                    agentId={agentId}
                    displayData={displayData}
                    isViewingOldVersion={isViewingOldVersion}
                    onFieldChange={handleFieldChange}
                    onExport={handleExport}
                    isExporting={exportMutation.isPending}
                    agentMetadata={agent?.metadata}
                    currentVersionId={agent?.current_version_id}
                    currentFormData={{
                      system_prompt: formData.system_prompt,
                      configured_mcps: formData.configured_mcps,
                      custom_mcps: formData.custom_mcps,
                      agentpress_tools: formData.agentpress_tools
                    }}
                    hasUnsavedChanges={hasUnsavedChanges}
                    onVersionCreated={() => {
                      setOriginalData(formData);
                    }}
                    onNameSave={handleNameSave}
                    onProfileImageSave={handleProfileImageSave}
                    onIconSave={handleIconSave}
                  />
                  <Drawer>
                    <DrawerTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={initiateAgentMutation.isPending}
                        className="flex items-center gap-2"
                      >
                        {initiateAgentMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : !testThreadId ? (
                          <Play className="h-4 w-4" />
                        ) : (
                          <Plus className="h-4 w-4" />
                        )}
                        {!testThreadId ? 'Run' : 'New'}
                      </Button>
                    </DrawerTrigger>
                    <DrawerContent className="px-4 pb-6">
                      <DrawerHeader className="text-center">
                        <DrawerTitle>Run Your Agent</DrawerTitle>
                        <p className="text-sm text-muted-foreground">
                          Start a conversation with your agent
                        </p>
                      </DrawerHeader>
                      
                      <div className="space-y-4 max-w-sm mx-auto">
                        <Button
                          onClick={!testThreadId ? handleStartTestMode : handleStartNewTask}
                          disabled={initiateAgentMutation.isPending}
                          className="w-full"
                          size="sm"
                        >
                          {initiateAgentMutation.isPending ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              Starting...
                            </>
                          ) : (
                            <>
                              <Play className="h-4 w-4 mr-2" />
                              {!testThreadId ? 'Start' : 'New Task'}
                            </>
                          )}
                        </Button>

                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground text-center">
                            Or try a suggested prompt:
                          </p>
                          
                          <div className="space-y-2">
                            <button
                              onClick={() => handleStartTestWithPrompt("Enter agent builder mode. Help me configure you to be my perfect agent. Ask me detailed questions about what I want you to do, how you should behave, what tools you need, and what knowledge would be helpful. Then suggest improvements to your system prompt, tools, and configuration.")}
                              disabled={initiateAgentMutation.isPending}
                              className="w-full text-left p-2 rounded border border-border hover:bg-accent text-xs transition-colors"
                            >
                              <span className="font-medium">Agent Builder Mode</span>
                              <br />
                              <span className="text-muted-foreground">Help configure the perfect agent</span>
                            </button>

                            <button
                              onClick={() => handleStartTestWithPrompt("Hi! I want to test your capabilities. Can you tell me who you are, what you can do, and what tools and knowledge you have access to? Then let's do a quick test to see how well you work.")}
                              disabled={initiateAgentMutation.isPending}
                              className="w-full text-left p-2 rounded border border-border hover:bg-accent text-xs transition-colors"
                            >
                              <span className="font-medium">Capability Test</span>
                              <br />
                              <span className="text-muted-foreground">Test what your agent can do</span>
                            </button>

                            <button
                              onClick={() => handleStartTestWithPrompt("I need help with a specific task. Let me explain what I'm trying to accomplish and you can guide me through the process step by step.")}
                              disabled={initiateAgentMutation.isPending}
                              className="w-full text-left p-2 rounded border border-border hover:bg-accent text-xs transition-colors"
                            >
                              <span className="font-medium">Task-Based Run</span>
                              <br />
                              <span className="text-muted-foreground">Start with a real task</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </DrawerContent>
                  </Drawer>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="h-full">
                <ConfigurationTab
                  agentId={agentId}
                  displayData={displayData}
                  versionData={versionData}
                  isViewingOldVersion={isViewingOldVersion}
                  onFieldChange={handleFieldChange}
                  onMCPChange={handleMCPChange}
                  onSystemPromptSave={handleSystemPromptSave}
                  onModelSave={handleModelSave}
                  onToolsSave={handleToolsSave}
                  initialAccordion={initialAccordion}
                  agentMetadata={agent?.metadata}
                  isLoading={updateAgentMutation.isPending}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function AgentConfigurationPage() {
  const {
    run,
    stepIndex,
    setStepIndex,
    stopTour,
    showWelcome,
    handleWelcomeAccept,
    handleWelcomeDecline,
  } = useAgentConfigTour();

  // OPTIMIZED: Simple function instead of useCallback with stable dependencies
  const handleTourCallback = (data: CallBackProps) => {
    const { status, type, index } = data;
    
    if (status === STATUS.FINISHED || status === STATUS.SKIPPED) {
      stopTour();
    } else if (type === 'step:after') {
      setStepIndex(index + 1);
    }
  };

  return (
    <>
      <Joyride
        steps={agentConfigTourSteps}
        run={run}
        stepIndex={stepIndex}
        callback={handleTourCallback}
        continuous
        showProgress
        showSkipButton
        disableOverlayClose
        disableScrollParentFix
        styles={{
          options: {
            primaryColor: '#000000',
            backgroundColor: '#ffffff',
            textColor: '#000000',
            overlayColor: 'rgba(0, 0, 0, 0.7)',
            arrowColor: '#ffffff',
            zIndex: 1000,
          },
          tooltip: {
            backgroundColor: '#ffffff',
            borderRadius: 8,
            fontSize: 14,
            padding: 20,
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
            border: '1px solid #e5e7eb',
          },
          tooltipContainer: {
            textAlign: 'left',
          },
          tooltipTitle: {
            color: '#000000',
            fontSize: 16,
            fontWeight: 600,
            marginBottom: 8,
          },
          tooltipContent: {
            color: '#000000',
            fontSize: 14,
            lineHeight: 1.5,
          },
          buttonNext: {
            backgroundColor: '#000000',
            color: '#ffffff',
            fontSize: 12,
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            fontWeight: 500,
          },
          buttonBack: {
            color: '#6b7280',
            backgroundColor: 'transparent',
            fontSize: 12,
            padding: '8px 16px',
            border: '1px solid #e5e7eb',
            borderRadius: 6,
          },
          buttonSkip: {
            color: '#6b7280',
            backgroundColor: 'transparent',
            fontSize: 12,
            border: 'none',
          },
          buttonClose: {
            color: '#6b7280',
            backgroundColor: 'transparent',
          },
        }}
      />
      <TourConfirmationDialog
        open={showWelcome}
        onAccept={handleWelcomeAccept}
        onDecline={handleWelcomeDecline}
      />
      <AgentConfigurationContent />
    </>
  );
} 