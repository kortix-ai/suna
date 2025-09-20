'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Settings,
  Wrench,
  Server,
  BookOpen,
  Workflow,
  Zap,
  Download,
  Loader2,
  Check,
  X,
  Edit3,
  Save,
  Brain,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

import { useAgentVersionData } from '@/hooks/use-agent-version-data';
import { useUpdateAgent } from '@/hooks/react-query/agents/use-agents';
import { useUpdateAgentMCPs } from '@/hooks/react-query/agents/use-update-agent-mcps';
import { useExportAgent } from '@/hooks/react-query/agents/use-agent-export-import';
import { ExpandableMarkdownEditor } from '@/components/ui/expandable-markdown-editor';
import { AgentModelSelector } from './config/model-selector';
import { AgentToolsConfiguration } from './agent-tools-configuration';
import { AgentMCPConfiguration } from './agent-mcp-configuration';
import { AgentKnowledgeBaseManager } from './knowledge-base/agent-knowledge-base-manager';
import { AgentPlaybooksConfiguration } from './playbooks/agent-playbooks-configuration';
import { AgentTriggersConfiguration } from './triggers/agent-triggers-configuration';
import { ProfilePictureDialog } from './config/profile-picture-dialog';
import { AgentIconAvatar } from './config/agent-icon-avatar';
import { AgentVersionSwitcher } from './agent-version-switcher';
import { DEFAULT_AGENTPRESS_TOOLS } from './tools';

interface AgentConfigurationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  initialTab?: 'general' | 'instructions' | 'tools' | 'integrations' | 'knowledge' | 'playbooks' | 'triggers';
}

export function AgentConfigurationDialog({
  open,
  onOpenChange,
  agentId,
  initialTab = 'general',
}: AgentConfigurationDialogProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  
  const { agent, versionData, isViewingOldVersion, isLoading, error } = useAgentVersionData({ agentId });
  
  const updateAgentMutation = useUpdateAgent();
  const updateAgentMCPsMutation = useUpdateAgentMCPs();
  const exportMutation = useExportAgent();
  
  const [activeTab, setActiveTab] = useState(initialTab);
  const [isProfileDialogOpen, setIsProfileDialogOpen] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    if (open && initialTab) {
      setActiveTab(initialTab);
    }
  }, [open, initialTab]);
  
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    system_prompt: '',
    model: undefined as string | undefined,
    agentpress_tools: DEFAULT_AGENTPRESS_TOOLS as Record<string, any>,
    configured_mcps: [] as any[],
    custom_mcps: [] as any[],
    is_default: false,
    profile_image_url: '',
    icon_name: null as string | null,
    icon_color: '#000000',
    icon_background: '#e5e5e5',
  });
  
  
  const [originalFormData, setOriginalFormData] = useState(formData);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!agent) return;
    
    let configSource = agent;
    if (versionData) {
      configSource = {
        ...agent,
        ...versionData,
        icon_name: versionData.icon_name || agent.icon_name,
        icon_color: versionData.icon_color || agent.icon_color,
        icon_background: versionData.icon_background || agent.icon_background,
      };
    }
    
    const newFormData = {
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
    setOriginalFormData(newFormData);
    setEditName(configSource.name || '');
  }, [agent, versionData]);

  const isSunaAgent = agent?.metadata?.is_suna_default || false;
  const restrictions = agent?.metadata?.restrictions || {};
  const isNameEditable = !isViewingOldVersion && (restrictions.name_editable !== false) && !isSunaAgent;
  const isSystemPromptEditable = !isViewingOldVersion && (restrictions.system_prompt_editable !== false) && !isSunaAgent;
  const areToolsEditable = !isViewingOldVersion && (restrictions.tools_editable !== false) && !isSunaAgent;
  
  const hasChanges = useMemo(() => {
    return JSON.stringify(formData) !== JSON.stringify(originalFormData);
  }, [formData, originalFormData]);

  const handleSaveAll = async () => {
    if (!hasChanges) return;
    
    setIsSaving(true);
    try {
      const updateData: any = {
        agentId,
        name: formData.name,
        description: formData.description,
        system_prompt: formData.system_prompt,
        agentpress_tools: formData.agentpress_tools,
      };
      
      if (formData.model !== undefined) updateData.model = formData.model;
      if (formData.profile_image_url !== undefined) updateData.profile_image_url = formData.profile_image_url;
      if (formData.icon_name !== undefined) updateData.icon_name = formData.icon_name;
      if (formData.icon_color !== undefined) updateData.icon_color = formData.icon_color;
      if (formData.icon_background !== undefined) updateData.icon_background = formData.icon_background;
      if (formData.is_default !== undefined) updateData.is_default = formData.is_default;
      
      const updatedAgent = await updateAgentMutation.mutateAsync(updateData);
      
      const mcpsChanged = 
        JSON.stringify(formData.configured_mcps) !== JSON.stringify(originalFormData.configured_mcps) ||
        JSON.stringify(formData.custom_mcps) !== JSON.stringify(originalFormData.custom_mcps);
      
      if (mcpsChanged) {
        await updateAgentMCPsMutation.mutateAsync({
          agentId,
          configured_mcps: formData.configured_mcps,
          custom_mcps: formData.custom_mcps,
          replace_mcps: true
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['versions', 'list', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents', 'detail', agentId] });
      
      if (updatedAgent.current_version_id) {
        const params = new URLSearchParams(searchParams.toString());
        params.delete('version');
        const newUrl = params.toString() ? `?${params.toString()}` : window.location.pathname;
        router.push(newUrl);
      }
      
      setOriginalFormData(formData);
      toast.success('Agent configuration saved successfully');
    } catch (error) {
      console.error('Failed to save changes:', error);
      toast.error('Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  const handleNameSave = () => {
    if (!editName.trim()) {
      setEditName(formData.name);
      setIsEditingName(false);
      return;
    }
    
    if (!isNameEditable) {
      if (isSunaAgent) {
        toast.error("Name cannot be edited", {
          description: "Suna's name is managed centrally and cannot be changed.",
        });
      }
      setEditName(formData.name);
      setIsEditingName(false);
      return;
    }
    
    setFormData(prev => ({ ...prev, name: editName }));
    setIsEditingName(false);
  };

  const handleSystemPromptChange = (value: string) => {
    if (!isSystemPromptEditable) {
      if (isSunaAgent) {
        toast.error("System prompt cannot be edited", {
          description: "Suna's system prompt is managed centrally.",
        });
      }
      return;
    }
    
    setFormData(prev => ({ ...prev, system_prompt: value }));
  };

  const handleModelChange = (model: string) => {
    setFormData(prev => ({ ...prev, model }));
  };

  const handleToolsChange = (tools: Record<string, boolean | { enabled: boolean; description: string }>) => {
    if (!areToolsEditable) {
      if (isSunaAgent) {
        toast.error("Tools cannot be edited", {
          description: "Suna's tools are managed centrally.",
        });
      }
      return;
    }
    
    setFormData(prev => ({ ...prev, agentpress_tools: tools }));
  };

  const handleMCPChange = (updates: { configured_mcps: any[]; custom_mcps: any[] }) => {
    setFormData(prev => ({
      ...prev,
      configured_mcps: updates.configured_mcps || [],
      custom_mcps: updates.custom_mcps || []
    }));
  };

  const handleProfileImageChange = (profileImageUrl: string | null) => {
    setFormData(prev => ({ ...prev, profile_image_url: profileImageUrl || '' }));
  };
  
  const handleIconChange = (iconName: string | null, iconColor: string, iconBackground: string) => {
    setFormData(prev => ({ 
      ...prev, 
      icon_name: iconName, 
      icon_color: iconColor, 
      icon_background: iconBackground,
      profile_image_url: iconName && prev.profile_image_url ? '' : prev.profile_image_url
    }));
  };

  const handleExport = () => {
    exportMutation.mutate(agentId);
  };
  
  const handleClose = (open: boolean) => {
    if (!open && hasChanges) {
      setFormData(originalFormData);
      setEditName(originalFormData.name);
    }
    onOpenChange(open);
  };

  if (error) {
    return null;
  }

  const tabItems = [
    { id: 'general', label: 'General', icon: Settings, disabled: false },
    { id: 'instructions', label: 'Instructions', icon: Brain, disabled: isSunaAgent },
    { id: 'tools', label: 'Tools', icon: Wrench, disabled: isSunaAgent },
    { id: 'integrations', label: 'Integrations', icon: Server, disabled: false },
    { id: 'knowledge', label: 'Knowledge', icon: BookOpen, disabled: false },
    { id: 'playbooks', label: 'Playbooks', icon: Workflow, disabled: false },
    { id: 'triggers', label: 'Triggers', icon: Zap, disabled: false },
  ];

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="max-w-5xl h-[85vh] overflow-hidden p-0 gap-0 flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-4 flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  className={cn(
                    "cursor-pointer transition-opacity hover:opacity-80",
                    isSunaAgent && "cursor-default hover:opacity-100"
                  )}
                  onClick={() => !isSunaAgent && setIsProfileDialogOpen(true)}
                  type="button"
                  disabled={isSunaAgent}
                >
                  {isSunaAgent ? (
                    <div className="h-10 w-10 rounded-lg bg-muted border flex items-center justify-center">
                      <KortixLogo size={18} />
                    </div>
                  ) : (
                    <AgentIconAvatar
                      profileImageUrl={formData.profile_image_url}
                      iconName={formData.icon_name}
                      iconColor={formData.icon_color}
                      backgroundColor={formData.icon_background}
                      agentName={formData.name}
                      size={40}
                      className="ring-1 ring-border hover:ring-foreground/20 transition-all"
                    />
                  )}
                </button>
                
                <div>
                  {isEditingName ? (
                    <div className="flex items-center gap-2">
                      <Input
                        ref={nameInputRef}
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleNameSave();
                          } else if (e.key === 'Escape') {
                            setEditName(formData.name);
                            setIsEditingName(false);
                          }
                        }}
                        className="h-8 w-64"
                        maxLength={50}
                      />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={handleNameSave}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => {
                          setEditName(formData.name);
                          setIsEditingName(false);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <DialogTitle className="text-xl font-semibold">
                        {isLoading ? 'Loading...' : formData.name || 'Agent'}
                      </DialogTitle>
                      {isNameEditable && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => {
                            setIsEditingName(true);
                            setTimeout(() => {
                              nameInputRef.current?.focus();
                              nameInputRef.current?.select();
                            }, 0);
                          }}
                        >
                          <Edit3 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  )}
                  <DialogDescription>
                    Configure your agent's capabilities and behavior
                  </DialogDescription>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <AgentVersionSwitcher
                  agentId={agentId}
                  currentVersionId={agent?.current_version_id || null}
                  currentFormData={{
                    system_prompt: formData.system_prompt,
                    configured_mcps: formData.configured_mcps,
                    custom_mcps: formData.custom_mcps,
                    agentpress_tools: formData.agentpress_tools,
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleExport}
                  disabled={exportMutation.isPending}
                >
                  {exportMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </DialogHeader>
          {isLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as typeof activeTab)} className="flex-1 flex flex-col min-h-0">
              <div className='flex items-center justify-center w-full'>
                <TabsList className="mt-4 w-[95%] flex-shrink-0">
                    {tabItems.map((tab) => {
                    const Icon = tab.icon;
                    return (
                        <TabsTrigger
                        key={tab.id}
                        value={tab.id}
                        disabled={tab.disabled}
                        className={cn(
                            tab.disabled && "opacity-50 cursor-not-allowed"
                        )}
                        >
                        <Icon className="h-4 w-4" />
                        {tab.label}
                        </TabsTrigger>
                    );
                    })}
                </TabsList>
              </div>
              <div className="flex-1 overflow-auto">
                  <TabsContent value="general" className="p-6 mt-0 flex flex-col h-full">
                    <div className="flex flex-col flex-1 gap-6">
                      <div className="flex-shrink-0">
                        <Label className="text-base font-semibold mb-3 block">Model</Label>
                        <AgentModelSelector
                          value={formData.model}
                          onChange={handleModelChange}
                          disabled={isViewingOldVersion}
                          variant="default"
                        />
                      </div>

                      <div className="flex flex-col flex-1 min-h-0">
                        <Label className="text-base font-semibold mb-3 block">Description</Label>
                        <Textarea
                          value={formData.description}
                          onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                          placeholder="Describe what this agent does..."
                          className="flex-1 resize-none bg-muted/50"
                          disabled={isViewingOldVersion}
                        />
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="instructions" className="p-6 mt-0 flex flex-col h-full">
                    <div className="flex flex-col flex-1 min-h-0">
                      <Label className="text-base font-semibold mb-3 block flex-shrink-0">System Prompt</Label>
                      <ExpandableMarkdownEditor
                        value={formData.system_prompt}
                        onSave={handleSystemPromptChange}
                        disabled={!isSystemPromptEditable}
                        placeholder="Define how your agent should behave..."
                        className="flex-1 h-[90%]"
                      />
                    </div>
                  </TabsContent>

                  <TabsContent value="tools" className="p-6 mt-0 h-[calc(100vh-16rem)]">
                    <AgentToolsConfiguration
                      tools={formData.agentpress_tools}
                      onToolsChange={handleToolsChange}
                      disabled={!areToolsEditable}
                    />
                  </TabsContent>
                  <TabsContent value="integrations" className="p-6 mt-0 h-[calc(100vh-16rem)]">
                    <AgentMCPConfiguration
                      configuredMCPs={formData.configured_mcps}
                      customMCPs={formData.custom_mcps}
                      onMCPChange={handleMCPChange}
                      agentId={agentId}
                      versionData={{
                        configured_mcps: formData.configured_mcps,
                        custom_mcps: formData.custom_mcps,
                        system_prompt: formData.system_prompt,
                        agentpress_tools: formData.agentpress_tools
                      }}
                      saveMode="callback"
                      isLoading={updateAgentMCPsMutation.isPending}
                    />
                  </TabsContent>

                  <TabsContent value="knowledge" className="p-6 mt-0 h-[calc(100vh-16rem)]">
                    <AgentKnowledgeBaseManager agentId={agentId} agentName={formData.name || 'Agent'} />
                  </TabsContent>

                  <TabsContent value="playbooks" className="p-6 mt-0 h-[calc(100vh-16rem)]">
                    <AgentPlaybooksConfiguration agentId={agentId} agentName={formData.name || 'Agent'} />
                  </TabsContent>

                  <TabsContent value="triggers" className="p-6 mt-0 h-[calc(100vh-16rem)]">
                    <AgentTriggersConfiguration agentId={agentId} />
                  </TabsContent>
              </div>
            </Tabs>
          )}
          
          <DialogFooter className="px-6 py-4 border-t bg-background flex-shrink-0">
            <Button 
              variant="outline" 
              onClick={() => handleClose(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleSaveAll}
              disabled={!hasChanges || isSaving}
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4" />
                  Save Changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProfilePictureDialog
        isOpen={isProfileDialogOpen}
        onClose={() => setIsProfileDialogOpen(false)}
        currentImageUrl={formData.profile_image_url}
        currentIconName={formData.icon_name}
        currentIconColor={formData.icon_color}
        currentBackgroundColor={formData.icon_background}
        agentName={formData.name}
        onImageUpdate={handleProfileImageChange}
        onIconUpdate={handleIconChange}
      />
    </>
  );
}
