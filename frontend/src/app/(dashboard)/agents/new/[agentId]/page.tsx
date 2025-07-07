'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Settings2, Sparkles, Check, Clock, Eye, Menu, Zap, Brain } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger, DrawerClose } from '@/components/ui/drawer';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAgent, useUpdateAgent } from '@/hooks/react-query/agents/use-agents';
import { AgentMCPConfiguration } from '../../_components/agent-mcp-configuration';
import { toast } from 'sonner';
import { AgentToolsConfiguration } from '../../_components/agent-tools-configuration';
import { AgentPreview } from '../../_components/agent-preview';
import { getAgentAvatar } from '../../_utils/get-agent-style';
import { EditableText } from '@/components/ui/editable';
import { StylePicker } from '../../_components/style-picker';
import { useSidebar } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentBuilderChat } from '../../_components/agent-builder-chat';
import { useFeatureAlertHelpers } from '@/hooks/use-feature-alerts';
import { AgentTriggersConfiguration } from '@/components/agents/triggers/agent-triggers-configuration';
import { AgentKnowledgeBaseManager } from '@/components/agents/knowledge-base/agent-knowledge-base-manager';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export default function AgentConfigurationPage() {
  const params = useParams();
  const router = useRouter();
  const agentId = params.agentId as string;

  const { data: agent, isLoading, error } = useAgent(agentId);
  const updateAgentMutation = useUpdateAgent();
  const { state, setOpen, setOpenMobile } = useSidebar();

  const initialLayoutAppliedRef = useRef(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    agentpress_tools: {},
    configured_mcps: [],
    custom_mcps: [],
    is_default: false,
    avatar: '',
    avatar_color: '',
  });

  const originalDataRef = useRef<typeof formData | null>(null);
  const currentFormDataRef = useRef(formData);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('agent-builder');
  const accordionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initialLayoutAppliedRef.current) {
      setOpen(false);
      initialLayoutAppliedRef.current = true;
    }
  }, [setOpen]);

  useEffect(() => {
    if (agent) {
      const agentData = agent as any;
      const initialData = {
        name: agentData.name || '',
        description: agentData.description || '',
        system_prompt: agentData.system_prompt || '',
        agentpress_tools: agentData.agentpress_tools || {},
        configured_mcps: agentData.configured_mcps || [],
        custom_mcps: agentData.custom_mcps || [],
        is_default: agentData.is_default || false,
        avatar: agentData.avatar || '',
        avatar_color: agentData.avatar_color || '',
      };
      setFormData(initialData);
      originalDataRef.current = { ...initialData };
    }
  }, [agent]);


  useEffect(() => {
    if (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Access denied') || errorMessage.includes('403')) {
        toast.error('You don\'t have permission to edit this agent');
        router.push('/agents');
        return;
      }
    }
  }, [error, router]);

  useEffect(() => {
    currentFormDataRef.current = formData;
  }, [formData]);

  const hasDataChanged = useCallback((newData: typeof formData, originalData: typeof formData | null): boolean => {
    if (!originalData) return true;
    if (newData.name !== originalData.name ||
        newData.description !== originalData.description ||
        newData.system_prompt !== originalData.system_prompt ||
        newData.is_default !== originalData.is_default ||
        newData.avatar !== originalData.avatar ||
        newData.avatar_color !== originalData.avatar_color) {
      return true;
    }
    if (JSON.stringify(newData.agentpress_tools) !== JSON.stringify(originalData.agentpress_tools) ||
        JSON.stringify(newData.configured_mcps) !== JSON.stringify(originalData.configured_mcps) ||
        JSON.stringify(newData.custom_mcps) !== JSON.stringify(originalData.custom_mcps)) {
      return true;
    }
    return false;
  }, []);

  const saveAgent = useCallback(async (data: typeof formData) => {
    try {
      setSaveStatus('saving');
      await updateAgentMutation.mutateAsync({
        agentId,
        ...data
      });
      originalDataRef.current = { ...data };
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (error) {
      console.error('Error updating agent:', error);
      setSaveStatus('error');
      toast.error('Failed to update agent');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [agentId, updateAgentMutation]);

  const debouncedSave = useCallback((data: typeof formData) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    if (!hasDataChanged(data, originalDataRef.current)) {
      return;
    }
    const timer = setTimeout(() => {
      if (hasDataChanged(data, originalDataRef.current)) {
        saveAgent(data);
      }
    }, 500);
    
    debounceTimerRef.current = timer;
  }, [saveAgent, hasDataChanged]);

  const handleFieldChange = useCallback((field: string, value: any) => {
    const newFormData = {
      ...currentFormDataRef.current,
      [field]: value
    };
    
    setFormData(newFormData);
    debouncedSave(newFormData);
  }, [debouncedSave]);

  const handleBatchMCPChange = useCallback((updates: { configured_mcps: any[]; custom_mcps: any[] }) => {
    const newFormData = {
      ...currentFormDataRef.current,
      configured_mcps: updates.configured_mcps,
      custom_mcps: updates.custom_mcps
    };
    
    setFormData(newFormData);
    debouncedSave(newFormData);
  }, [debouncedSave]);

  const scrollToAccordion = useCallback(() => {
    if (accordionRef.current) {
      accordionRef.current.scrollIntoView({ 
        behavior: 'smooth', 
        block: 'end' 
      });
    }
  }, []);

  const handleStyleChange = useCallback((emoji: string, color: string) => {
    const newFormData = {
      ...currentFormDataRef.current,
      avatar: emoji,
      avatar_color: color,
    };
    setFormData(newFormData);
    debouncedSave(newFormData);
  }, [debouncedSave]);

  const currentStyle = useMemo(() => {
    if (formData.avatar && formData.avatar_color) {
      return {
        avatar: formData.avatar,
        color: formData.avatar_color,
      };
    }
    return getAgentAvatar(agentId);
  }, [formData.avatar, formData.avatar_color, agentId]);

  const memoizedAgentBuilderChat = useMemo(() => (
    <AgentBuilderChat
      agentId={agentId}
      formData={formData}
      handleFieldChange={handleFieldChange}
      handleStyleChange={handleStyleChange}
      currentStyle={currentStyle}
    />
  ), [agentId, formData, handleFieldChange, handleStyleChange, currentStyle]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const getSaveStatusBadge = () => {
    const showSaved = saveStatus === 'idle' && !hasDataChanged(formData, originalDataRef.current);
    switch (saveStatus) {
      case 'saving':
        return (
          <Badge variant="secondary" className="flex items-center gap-1 text-amber-700 dark:text-amber-300 bg-amber-600/30 hover:bg-amber-700/40">
            <Clock className="h-3 w-3 animate-pulse" />
            Saving...
          </Badge>
        );
      case 'saved':
        return (
          <Badge variant="default" className="flex items-center gap-1 text-green-700 dark:text-green-300 bg-green-600/30 hover:bg-green-700/40">
            <Check className="h-3 w-3" />
            Saved
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="destructive" className="flex items-center gap-1 text-red-700 dark:text-red-300 bg-red-600/30 hover:bg-red-700/40">
            Error saving
          </Badge>
        );

      default:
        return showSaved ? (
          <Badge variant="default" className="flex items-center gap-1 text-green-700 dark:text-green-300 bg-green-600/30 hover:bg-green-700/40">
            <Check className="h-3 w-3" />
            Saved
          </Badge>
        ) : (
          <Badge variant="destructive" className="flex items-center gap-1 text-red-700 dark:text-red-300 bg-red-600/30 hover:bg-red-700/40">
            Error saving
          </Badge>
        );
    }
  };

  const ConfigurationContent = useMemo(() => {
    return (
      <div className="h-full flex flex-col">
        <div className="md:hidden flex justify-between items-center mb-4 p-4 pb-0">
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setOpenMobile(true)}
                  className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-accent"
                >
                  <Menu className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Open menu</TooltipContent>
            </Tooltip>
            <div className="md:hidden flex justify-center">
              {getSaveStatusBadge()}
            </div>
          </div>
          <Drawer open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
            <DrawerTrigger asChild>
              <Button variant="outline" size="sm">
                <Eye className="h-4 w-4" />
                Preview
              </Button>
            </DrawerTrigger>
            <DrawerContent className="h-[90vh] bg-muted">
              <DrawerHeader>
                <DrawerTitle>Agent Preview</DrawerTitle>
              </DrawerHeader>
              <div className="flex-1 overflow-y-auto px-4 pb-4">
                <AgentPreview agent={{ ...agent, ...formData }} />
              </div>
            </DrawerContent>
          </Drawer>
        </div>
        
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
          <div className='w-full flex items-center justify-center flex-shrink-0 px-4 md:px-12 md:mt-10'>
            <div className='w-auto flex items-center gap-2'>
              <TabsList className="grid h-auto w-full grid-cols-2 bg-muted-foreground/10">
                <TabsTrigger value="agent-builder" className="w-48 flex items-center gap-1.5 px-2">
                  <span className="truncate">Agent Builder</span>
                  <Badge variant="beta">
                    Beta
                  </Badge>
                </TabsTrigger>
                <TabsTrigger value="manual">Manual</TabsTrigger>
              </TabsList>
            </div>
          </div>
          <TabsContent value="manual" className="mt-0 flex-1 overflow-y-auto overflow-x-hidden px-4 md:px-12 pb-4 md:pb-12 scrollbar-hide">
            <div className="max-w-full">
              <div className="hidden md:flex justify-end mb-4 mt-4">
                {getSaveStatusBadge()}
              </div>
              <div className='flex items-start md:items-center flex-col md:flex-row mt-6'>
                <StylePicker 
                  agentId={agentId} 
                  currentEmoji={currentStyle.avatar}
                  currentColor={currentStyle.color}
                  onStyleChange={handleStyleChange}
                >
                  <div 
                    className="flex-shrink-0 h-12 w-12 md:h-16 md:w-16 flex items-center justify-center rounded-2xl text-xl md:text-2xl cursor-pointer hover:opacity-80 transition-opacity mb-3 md:mb-0"
                    style={{ backgroundColor: currentStyle.color }}
                  >
                    {currentStyle.avatar}
                  </div>
                </StylePicker>
                <div className='flex flex-col md:ml-3 w-full min-w-0'>
                  <EditableText
                    value={formData.name}
                    onSave={(value) => handleFieldChange('name', value)}
                    className="text-lg md:text-xl font-semibold bg-transparent"
                    placeholder="Click to add agent name..."
                  />
                  <EditableText
                    value={formData.description}
                    onSave={(value) => handleFieldChange('description', value)}
                    className="text-muted-foreground text-sm md:text-base"
                    placeholder="Click to add description..."
                  />
                </div>
              </div>

              <div className='flex flex-col mt-6 md:mt-8'>
                <div className='text-sm font-semibold text-muted-foreground mb-2'>Instructions</div>
                <EditableText
                  value={formData.system_prompt}
                  onSave={(value) => handleFieldChange('system_prompt', value)}
                  className='bg-transparent hover:bg-transparent border-none focus-visible:ring-0 shadow-none text-sm md:text-base'
                  placeholder='Click to set system instructions...'
                  multiline={true}
                  minHeight="150px"
                />
              </div>

              <div ref={accordionRef} className="mt-6 border-t">
                <Accordion 
                  type="multiple" 
                  defaultValue={[]} 
                  className="space-y-2"
                  onValueChange={scrollToAccordion}
                >
                  <AccordionItem value="tools" className="border-b">
                    <AccordionTrigger className="hover:no-underline text-sm md:text-base">
                      <div className="flex items-center gap-2">
                        <Settings2 className="h-4 w-4" />
                        Default Tools
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4 overflow-x-hidden">
                      <AgentToolsConfiguration
                        tools={formData.agentpress_tools}
                        onToolsChange={(tools) => handleFieldChange('agentpress_tools', tools)}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="mcp" className="border-b">
                    <AccordionTrigger className="hover:no-underline text-sm md:text-base">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4" />
                        Integrations (via MCP)
                        <Badge variant='new'>New</Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4 overflow-x-hidden">
                      <AgentMCPConfiguration
                        mcps={formData.configured_mcps}
                        customMcps={formData.custom_mcps}
                        onMCPsChange={(mcps) => handleBatchMCPChange({ configured_mcps: mcps, custom_mcps: formData.custom_mcps })}
                        onCustomMCPsChange={(customMcps) => handleBatchMCPChange({ configured_mcps: formData.configured_mcps, custom_mcps: customMcps })}
                        onBatchMCPChange={handleBatchMCPChange}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="triggers" className="border-b">
                    <AccordionTrigger className="hover:no-underline text-sm md:text-base">
                      <div className="flex items-center gap-2">
                        <Zap className="h-4 w-4" />
                        Triggers
                        <Badge variant='new'>New</Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4 overflow-x-hidden">
                      <AgentTriggersConfiguration
                        agentId={agentId}
                      />
                    </AccordionContent>
                  </AccordionItem>

                  <AccordionItem value="knowledge-base" className="border-b">
                    <AccordionTrigger className="hover:no-underline text-sm md:text-base">
                      <div className="flex items-center gap-2">
                        <Brain className="h-4 w-4" />
                        Knowledge Base
                        <Badge variant='new'>New</Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pb-4 overflow-x-hidden">
                      <AgentKnowledgeBaseManager
                        agentId={agentId}
                        agentName={formData.name || 'Agent'}
                      />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            </div>
          </TabsContent>
          
          <TabsContent value="agent-builder" className="mt-0 flex-1 flex flex-col overflow-hidden">
            {memoizedAgentBuilderChat}
          </TabsContent>
        </Tabs>
      </div>
    );
  }, [
    activeTab,
    agentId,
    agent,
    formData,
    currentStyle,
    isPreviewOpen,
    memoizedAgentBuilderChat,
    handleFieldChange,
    handleStyleChange,
    setOpenMobile,
    setIsPreviewOpen,
    setActiveTab,
    scrollToAccordion,
    getSaveStatusBadge,
    handleBatchMCPChange
  ]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="flex items-center gap-2">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span>Loading agent...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAccessDenied = errorMessage.includes('Access denied') || errorMessage.includes('403');
    
    return (
      <div className="container mx-auto max-w-7xl px-4 py-8">
        <div className="text-center space-y-4">
          {isAccessDenied ? (
            <Alert variant="destructive">
              <AlertDescription>
                You don't have permission to edit this agent. You can only edit agents that you created.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <h2 className="text-xl font-semibold mb-2">Agent not found</h2>
              <p className="text-muted-foreground mb-4">The agent you're looking for doesn't exist.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 flex overflow-hidden">
        <div className="hidden md:flex w-full h-full">
          <div className="w-1/2 border-r bg-background h-full flex flex-col">
            {ConfigurationContent}
          </div>
          <div className="w-1/2 overflow-y-auto">
            <AgentPreview agent={{ ...agent, ...formData }} />
          </div>
        </div>
        <div className="md:hidden w-full h-full flex flex-col">
          {ConfigurationContent}
        </div>
      </div>
    </div>
  );
}