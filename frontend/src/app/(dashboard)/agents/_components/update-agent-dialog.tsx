import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Loader2, Search, Save, Settings2, Sparkles, GitBranch } from 'lucide-react';
import { toast } from 'sonner';
import { Skeleton } from '@/components/ui/skeleton';
import { DEFAULT_AGENTPRESS_TOOLS, getToolDisplayName } from '../_data/tools';
import { useAgent, useUpdateAgent } from '@/hooks/react-query/agents/use-agents';
import { MCPConfigurationNew } from './mcp/mcp-configuration-new';
import { AgentVersionManager } from './AgentVersionManager';
import { Badge } from '@/components/ui/badge';

interface AgentUpdateRequest {
  name?: string;
  description?: string;
  system_prompt?: string;
  configured_mcps?: Array<{ name: string; qualifiedName: string; config: any; enabledTools?: string[] }>;
  custom_mcps?: Array<{ name: string; type: 'json' | 'sse'; config: any; enabledTools: string[] }>;
  agentpress_tools?: Record<string, { enabled: boolean; description: string }>;
  is_default?: boolean;
}

interface UpdateAgentDialogProps {
  agentId: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onAgentUpdated?: () => void;
}

const TOOL_CATEGORIES = ['All', 'AI', 'Code', 'Integration', 'Search', 'File', 'Data'];

export const UpdateAgentDialog = ({ agentId, isOpen, onOpenChange, onAgentUpdated }: UpdateAgentDialogProps) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [formData, setFormData] = useState<AgentUpdateRequest>({});

  const { 
    data: agent, 
    isLoading, 
    error 
  } = useAgent(agentId || '');
  
  const updateAgentMutation = useUpdateAgent();

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setSelectedCategory('All');
      setFormData({});
    }
  }, [isOpen]);

  useEffect(() => {
    if (agent && isOpen) {
      setFormData({
        name: agent.name,
        description: agent.description || '',
        system_prompt: agent.system_prompt,
        configured_mcps: (agent.configured_mcps || []).map(mcp => ({
          name: mcp.name,
          qualifiedName: (mcp as any).qualifiedName || mcp.name,
          config: mcp.config,
          enabledTools: (mcp as any).enabledTools || []
        })),
        custom_mcps: agent.custom_mcps || [],
        agentpress_tools: agent.agentpress_tools || {},
        is_default: agent.is_default,
      });
    }
  }, [agent, isOpen]);

  useEffect(() => {
    if (error && isOpen) {
      console.error('Error loading agent:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to load agent');
      onOpenChange(false);
    }
  }, [error, isOpen, onOpenChange]);

  const handleInputChange = (field: keyof AgentUpdateRequest, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
  };

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    setFormData(prev => ({
      ...prev,
      agentpress_tools: {
        ...prev.agentpress_tools,
        [toolName]: {
          ...prev.agentpress_tools?.[toolName],
          enabled
        }
      }
    }));
  };

  const handleMCPConfigurationChange = (mcps: any[]) => {
    // Separate standard and custom MCPs
    const standardMcps = mcps.filter(mcp => !mcp.isCustom);
    const customMcps = mcps.filter(mcp => mcp.isCustom).map(mcp => ({
      name: mcp.name,
      type: mcp.customType as 'json' | 'sse',
      config: mcp.config,
      enabledTools: mcp.enabledTools || []
    }));
    
    handleInputChange('configured_mcps', standardMcps);
    handleInputChange('custom_mcps', customMcps);
  };

  const getAllAgentPressTools = () => {
    const existing = formData.agentpress_tools || {};
    const merged = { ...DEFAULT_AGENTPRESS_TOOLS };
    
    Object.keys(existing).forEach(key => {
      merged[key] = { ...merged[key], ...existing[key] };
    });
    
    return merged;
  };

  const getSelectedToolsCount = (): number => {
    const tools = getAllAgentPressTools();
    return Object.values(tools).filter(tool => tool.enabled).length;
  };

  const getFilteredTools = (): Array<[string, any]> => {
    let tools = Object.entries(getAllAgentPressTools());
    
    if (searchQuery) {
      tools = tools.filter(([toolName, toolInfo]) => 
        getToolDisplayName(toolName).toLowerCase().includes(searchQuery.toLowerCase()) ||
        toolInfo.description.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }
    
    return tools;
  };

  const handleSubmit = async () => {
    if (!formData.name?.trim()) {
      toast.error('Agent name is required');
      return;
    }

    if (!formData.system_prompt?.trim()) {
      toast.error('System prompt is required');
      return;
    }

    if (!agentId) {
      toast.error('Invalid agent ID');
      return;
    }

    try {
      await updateAgentMutation.mutateAsync({
        agentId,
        ...formData
      });
      
      toast.success('Agent updated successfully!');
      onOpenChange(false);
      onAgentUpdated?.();
    } catch (error: any) {
      console.error('Error updating agent:', error);
      
      if (error.message?.includes('System prompt cannot be empty')) {
        toast.error('System prompt cannot be empty');
      } else if (error.message?.includes('Failed to create new agent version')) {
        toast.error('Failed to create new version. Please try again.');
      } else if (error.message?.includes('Failed to update agent')) {
        toast.error('Failed to update agent. Please check your configuration and try again.');
      } else if (error.message?.includes('Agent not found')) {
        toast.error('Agent not found. It may have been deleted.');
        onOpenChange(false);
      } else if (error.message?.includes('Access denied')) {
        toast.error('You do not have permission to update this agent.');
        onOpenChange(false);
      } else {
        toast.error(error.message || 'Failed to update agent. Please try again.');
      }
    }
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  if (isLoading || !agent) {
    return (
      <Dialog open={isOpen} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl h-[85vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
            <DialogTitle className="text-xl font-semibold">
              Edit Agent
            </DialogTitle>
            <DialogDescription className="text-sm mt-1">
              Loading agent configuration...
            </DialogDescription>
          </DialogHeader>
          
          <div className="flex-1 p-6">
            <div className="space-y-4">
              {[1, 2, 3].map(i => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-32 w-full" />
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl h-[85vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-6 py-4 border-b flex-shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle className="text-xl font-semibold flex items-center gap-2">
                Edit Agent
                {(agent as any).current_version && (
                  <Badge variant="secondary" className="text-xs">
                    {(agent as any).current_version.version_name}
                  </Badge>
                )}
              </DialogTitle>
              <DialogDescription className="text-sm mt-1">
                Modify your agent's configuration and capabilities
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 w-full overflow-hidden min-h-0">
          <div className="flex w-full h-full">
            {/* Left Panel - Basic Configuration */}
            <div className="p-6 py-4 w-[40%] space-y-6 overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
              <div className="space-y-2">
                <Label htmlFor="agent-name" className="text-sm font-medium">
                  Agent Name
                </Label>
                <Input
                  id="agent-name"
                  value={formData.name || ''}
                  onChange={(e) => handleInputChange('name', e.target.value)}
                  placeholder="e.g., Research Assistant"
                  className="h-10"
                  disabled={updateAgentMutation.isPending}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="agent-description" className="text-sm font-medium">
                  Description
                </Label>
                <Input
                  id="agent-description"
                  value={formData.description || ''}
                  onChange={(e) => handleInputChange('description', e.target.value)}
                  placeholder="Brief description of the agent"
                  className="h-10"
                  disabled={updateAgentMutation.isPending}
                />
              </div>

              <div className="space-y-2 flex-1">
                <Label htmlFor="system-instructions" className="text-sm font-medium">
                  System Instructions
                </Label>
                <Textarea
                  id="system-instructions"
                  value={formData.system_prompt || ''}
                  onChange={(e) => handleInputChange('system_prompt', e.target.value)}
                  placeholder="Describe the agent's role, behavior, and expertise..."
                  className="min-h-[250px] resize-none"
                  disabled={updateAgentMutation.isPending}
                />
              </div>
            </div>

            {/* Right Panel - Tools & MCP */}
            <div className="border-l w-[60%] bg-muted/30 flex flex-col min-h-0">
              <Tabs defaultValue="tools" className="flex flex-col h-full">
                <TabsList className="w-full justify-start rounded-none border-b h-10">
                  <TabsTrigger 
                    value="tools" 
                  >
                    <Settings2 className="h-4 w-4" />
                    Default Tools
                  </TabsTrigger>
                  <TabsTrigger 
                    value="mcp" 
                  >
                    <Sparkles className="h-4 w-4" />
                    MCP Servers
                  </TabsTrigger>
                  <TabsTrigger 
                    value="versions" 
                  >
                    <GitBranch className="h-4 w-4" />
                    Versions
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="tools" className="flex-1 flex flex-col m-0 min-h-0">
                  <div className="px-6 py-4 border-b bg-background flex-shrink-0">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-semibold">Available Tools</h3>
                      <span className="text-sm text-muted-foreground">
                        {getSelectedToolsCount()} selected
                      </span>
                    </div>

                    <div className="relative mb-4">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search tools..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 h-10"
                        disabled={updateAgentMutation.isPending}
                      />
                    </div>

                    <div className="flex gap-2 flex-wrap">
                      {TOOL_CATEGORIES.map((category) => (
                        <Button
                          key={category}
                          variant={selectedCategory === category ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setSelectedCategory(category)}
                          disabled={updateAgentMutation.isPending}
                          className="px-3 py-1.5 h-auto text-xs font-medium rounded-full"
                        >
                          {category}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent p-6 min-h-0">
                    <div className="space-y-3">
                      {getFilteredTools().map(([toolName, toolInfo]) => (
                        <div 
                          key={toolName} 
                          className="flex items-center gap-3 p-3 bg-card rounded-lg border hover:border-border/80 transition-colors"
                        >
                          <div className={`w-10 h-10 rounded-lg ${toolInfo.color} flex items-center justify-center flex-shrink-0`}>
                            <span className="text-lg">{toolInfo.icon}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between mb-1">
                              <h4 className="font-medium text-sm">
                                {getToolDisplayName(toolName)}
                              </h4>
                              <Switch
                                checked={toolInfo.enabled || false}
                                onCheckedChange={(checked) => handleToolToggle(toolName, checked)}
                                disabled={updateAgentMutation.isPending}
                                className="flex-shrink-0"
                              />
                            </div>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {toolInfo.description}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>

                    {getFilteredTools().length === 0 && (
                      <div className="text-center py-8">
                        <div className="text-4xl mb-3">🔍</div>
                        <h3 className="text-sm font-medium mb-1">No tools found</h3>
                        <p className="text-xs text-muted-foreground">Try adjusting your search criteria</p>
                      </div>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="mcp" className="flex-1 m-0 p-6 overflow-y-auto">
                  <MCPConfigurationNew
                    configuredMCPs={[...(formData.configured_mcps || []), ...(formData.custom_mcps || []).map(customMcp => ({
                      name: customMcp.name,
                      qualifiedName: `custom_${customMcp.type}_${customMcp.name.replace(' ', '_').toLowerCase()}`,
                      config: customMcp.config,
                      enabledTools: customMcp.enabledTools,
                      isCustom: true,
                      customType: customMcp.type
                    }))]}
                    onConfigurationChange={handleMCPConfigurationChange}
                  />
                </TabsContent>

                <TabsContent value="versions" className="flex-1 m-0 p-6 overflow-y-auto">
                  <AgentVersionManager 
                    agent={agent as any}
                    onCreateVersion={() => {
                      // When creating a new version, save current changes first
                      handleSubmit();
                    }}
                  />
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>

        <div className="px-6 border-t py-4 flex-shrink-0">
          <div className="space-y-3">
            {/* Show notice if changes will create a new version */}
            {agent && (formData.system_prompt !== agent.system_prompt || 
              JSON.stringify(formData.configured_mcps) !== JSON.stringify(agent.configured_mcps) ||
              JSON.stringify(formData.custom_mcps) !== JSON.stringify(agent.custom_mcps) ||
              JSON.stringify(formData.agentpress_tools) !== JSON.stringify(agent.agentpress_tools)) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-3 py-2 rounded-md">
                <GitBranch className="h-4 w-4" />
                <span>These changes will create a new version of your agent</span>
              </div>
            )}
            
            <div className="flex justify-end gap-3">
              <Button 
                variant="outline"
                onClick={handleCancel}
                disabled={updateAgentMutation.isPending}
                className="px-6"
              >
                Cancel
              </Button>
              <Button 
                onClick={handleSubmit}
                disabled={updateAgentMutation.isPending || !formData.name?.trim() || !formData.system_prompt?.trim()}
              >
                {updateAgentMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving Changes
                  </>
                ) : (
                  <>
                    <Save className="h-4 w-4" />
                    Save Changes
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}