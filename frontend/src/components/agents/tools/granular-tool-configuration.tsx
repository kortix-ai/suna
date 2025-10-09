'use client';

import React, { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Search, ChevronDown, ChevronRight, Settings2, Wrench, Loader2 } from 'lucide-react';
import { icons } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useToolsMetadata } from '@/hooks/react-query/tools/use-tools-metadata';
import { 
  getToolGroup, 
  hasGranularControl, 
  validateToolConfig,
  getAllToolGroups,
  sortToolsByWeight,
  type ToolGroup,
  type ToolMethod 
} from './tool-groups';

interface GranularToolConfigurationProps {
  tools: Record<string, any>;
  onToolsChange: (tools: Record<string, any>) => void;
  disabled?: boolean;
  isSunaAgent?: boolean;
  isLoading?: boolean;
}

export const GranularToolConfiguration = ({ 
  tools, 
  onToolsChange, 
  disabled = false, 
  isSunaAgent = false, 
  isLoading = false 
}: GranularToolConfigurationProps) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Fetch tools metadata from API
  const { data: toolsMetadata, isLoading: isLoadingTools } = useToolsMetadata();
  const toolsData = toolsMetadata?.success ? toolsMetadata.tools : undefined;
  const TOOL_GROUPS = getAllToolGroups(toolsData);

  const getIconComponent = (iconName?: string) => {
    if (!iconName) return Wrench;
    const IconComponent = (icons as any)[iconName];
    return IconComponent || Wrench;
  };

  const isToolGroupEnabled = (toolName: string): boolean => {
    const toolConfig = tools[toolName];
    if (toolConfig === undefined) return false;
    if (typeof toolConfig === 'boolean') return toolConfig;
    if (typeof toolConfig === 'object' && toolConfig !== null) {
      return toolConfig.enabled ?? true;
    }
    return false;
  };

  const isMethodEnabled = (toolName: string, methodName: string): boolean => {
    const toolConfig = tools[toolName];
    if (!isToolGroupEnabled(toolName)) return false;
    
    if (typeof toolConfig === 'boolean') return toolConfig;
    if (typeof toolConfig === 'object' && toolConfig !== null) {
      const methodsConfig = toolConfig.methods || {};
      const methodConfig = methodsConfig[methodName];
      
      if (typeof methodConfig === 'boolean') return methodConfig;
      if (typeof methodConfig === 'object' && methodConfig !== null) {
        return methodConfig.enabled ?? true;
      }
      
      // Default to method's default enabled state from tool group
      const toolGroup = getToolGroup(toolName, toolsData);
      const method = toolGroup?.methods.find(m => m.name === methodName);
      return method?.enabled ?? true;
    }
    return false;
  };

  const handleToolGroupToggle = (toolName: string, enabled: boolean) => {
    const toolGroup = getToolGroup(toolName, toolsData);
    
    if (disabled && isSunaAgent) {
      toast.error("Tools cannot be modified", {
        description: "Suna's default tools are managed centrally and cannot be changed.",
      });
      return;
    }
    
    if (isLoading) return;

    const updatedTools = { ...tools };
    
    if (hasGranularControl(toolName, toolsData)) {
      // For tools with granular control, maintain method configuration
      const currentConfig = tools[toolName];
      if (typeof currentConfig === 'object' && currentConfig !== null) {
        updatedTools[toolName] = {
          ...currentConfig,
          enabled,
        };
      } else {
        // Convert to granular format
        const toolGroup = getToolGroup(toolName, toolsData);
        updatedTools[toolName] = {
          enabled,
          methods: toolGroup?.methods.reduce((acc, method) => {
            acc[method.name] = method.enabled;
            return acc;
          }, {} as Record<string, boolean>) || {},
        };
      }
    } else {
      // Simple boolean toggle for non-granular tools
      updatedTools[toolName] = enabled;
    }
    
    onToolsChange(updatedTools);
  };

  const handleMethodToggle = (toolName: string, methodName: string, enabled: boolean) => {
    const toolGroup = getToolGroup(toolName, toolsData);
    const method = toolGroup?.methods.find(m => m.name === methodName);
    
    if (disabled && isSunaAgent) {
      toast.error("Methods cannot be modified", {
        description: "Suna's default tool methods are managed centrally and cannot be changed.",
      });
      return;
    }
    
    if (isLoading) return;

    const updatedTools = { ...tools };
    const currentConfig = tools[toolName];
    
    if (typeof currentConfig === 'object' && currentConfig !== null) {
      updatedTools[toolName] = {
        ...currentConfig,
        methods: {
          ...currentConfig.methods,
          [methodName]: enabled,
        },
      };
    } else {
      // Convert to granular format
      updatedTools[toolName] = {
        enabled: isToolGroupEnabled(toolName),
        methods: {
          ...toolGroup?.methods.reduce((acc, method) => {
            acc[method.name] = method.name === methodName ? enabled : method.enabled;
            return acc;
          }, {} as Record<string, boolean>) || {},
        },
      };
    }
    
    onToolsChange(updatedTools);
  };

  const toggleGroupExpansion = (toolName: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(toolName)) {
      newExpanded.delete(toolName);
    } else {
      newExpanded.add(toolName);
    }
    setExpandedGroups(newExpanded);
  };

  const getFilteredToolGroups = (): ToolGroup[] => {
    // Sort tools by weight (lower weight = higher priority)
    const sortedTools = sortToolsByWeight(TOOL_GROUPS);
    
    // Filter only visible tools
    const visibleTools = sortedTools.filter(group => group.visible !== false);
    
    // Apply search filter
    return visibleTools.filter(group => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      return (
        group.displayName.toLowerCase().includes(query) ||
        group.description.toLowerCase().includes(query) ||
        group.methods.some(method => 
          method.displayName.toLowerCase().includes(query) ||
          method.description.toLowerCase().includes(query)
        )
      );
    });
  };

  const getEnabledToolsCount = (): number => {
    return Object.entries(tools).filter(([toolName, toolConfig]) => {
      return isToolGroupEnabled(toolName);
    }).length;
  };

  const getEnabledMethodsCount = (toolName: string): number => {
    const toolGroup = getToolGroup(toolName, toolsData);
    if (!toolGroup) return 0;
    
    // Only count visible methods
    return toolGroup.methods
      .filter(method => method.visible !== false)
      .filter(method => isMethodEnabled(toolName, method.name)).length;
  };

  const filteredGroups = getFilteredToolGroups();

  // Show loading state while fetching tools
  if (isLoadingTools) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">Loading tools...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full space-y-6">
      <div className="flex items-center justify-between flex-shrink-0">
        <div>
          <h3 className="text-lg font-semibold">Tool Configuration</h3>
          <p className="text-sm text-muted-foreground">
            Configure tools and their individual capabilities for your agent
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          {getEnabledToolsCount()} / {Object.keys(TOOL_GROUPS).length} tools enabled
        </Badge>
      </div>

      <div className="relative flex-shrink-0">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
        <Input
          placeholder="Search tools and capabilities..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <ScrollArea className="flex-1 pr-4">
        <div className="space-y-2">
          {filteredGroups.map((toolGroup) => {
            const isGroupEnabled = isToolGroupEnabled(toolGroup.name);
            const isExpanded = expandedGroups.has(toolGroup.name);
            const enabledMethodsCount = getEnabledMethodsCount(toolGroup.name);
            const totalMethodsCount = toolGroup.methods.filter(m => m.visible !== false).length;
            const IconComponent = getIconComponent(toolGroup.icon);
            const hasGranular = hasGranularControl(toolGroup.name, toolsData);

            return (
              <div key={toolGroup.name} className="border rounded-lg">
                <div className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3 flex-1 min-w-0">
                      <div className={cn(
                        "flex items-center justify-center w-8 h-8 rounded-md flex-shrink-0",
                        toolGroup.color
                      )}>
                        <IconComponent className="h-4 w-4" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-sm truncate">
                            {toolGroup.displayName}
                          </h4>
                          {toolGroup.isCore && (
                            <Badge variant="outline" className="text-xs">Core</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {toolGroup.description}
                        </p>
                        {hasGranular && isGroupEnabled && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {enabledMethodsCount} / {totalMethodsCount} capabilities enabled
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {hasGranular && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleGroupExpansion(toolGroup.name)}
                          className="p-1 h-auto"
                          disabled={!isGroupEnabled}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                      
                      <Switch
                        checked={isGroupEnabled}
                        onCheckedChange={(enabled) => handleToolGroupToggle(toolGroup.name, enabled)}
                        disabled={disabled || isLoading}
                      />
                    </div>
                  </div>

                  {hasGranular && isExpanded && isGroupEnabled && (
                    <Collapsible open={isExpanded}>
                      <CollapsibleContent className="mt-4 pt-4 border-t">
                        <div className="space-y-3">
                          <div className="flex items-center gap-2 mb-3">
                            <Settings2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium text-muted-foreground">
                              Individual Capabilities
                            </span>
                          </div>
                          
                          {toolGroup.methods
                            .filter(method => method.visible !== false) // Only show visible methods
                            .map((method) => {
                            const isMethodEnabledState = isMethodEnabled(toolGroup.name, method.name);
                            
                            return (
                              <div key={method.name} className="flex items-center justify-between pl-6">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h5 className="text-sm font-medium truncate">
                                      {method.displayName}
                                    </h5>
                                    {method.isCore && (
                                      <Badge variant="outline" className="text-xs">Core</Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-muted-foreground truncate">
                                    {method.description}
                                  </p>
                                </div>
                                
                                <Switch
                                  checked={isMethodEnabledState}
                                  onCheckedChange={(enabled) => 
                                    handleMethodToggle(toolGroup.name, method.name, enabled)
                                  }
                                  disabled={disabled || isLoading}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
};
