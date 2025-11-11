'use client';

import React, { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Search, ChevronDown, ChevronRight, Settings2, Wrench, Loader2 } from 'lucide-react';
import { icons } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useToolsMetadata } from '@/hooks/tools/use-tools-metadata';
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
    <div className="flex flex-col h-full w-full min-w-0">
      <div className="flex items-center justify-between flex-shrink-0 mb-4 w-full">
        <div>
          <h3 className="text-lg font-semibold">Tool Configuration</h3>
          <p className="text-sm text-muted-foreground">
            Configure tools and their individual capabilities for your agent
          </p>
        </div>
        <Badge variant="default" className="text-xs">
          {getEnabledToolsCount()} / {Object.keys(TOOL_GROUPS).length} tools enabled
        </Badge>
      </div>

      <div className="relative flex-shrink-0 mb-4">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
        <Input
          placeholder="Search tools and capabilities..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <div className="flex-1 overflow-auto pr-1 w-full min-w-0">
        <div className="space-y-2 pb-4 w-full">
          {filteredGroups.map((toolGroup) => {
            const isGroupEnabled = isToolGroupEnabled(toolGroup.name);
            const isExpanded = expandedGroups.has(toolGroup.name);
            const enabledMethodsCount = getEnabledMethodsCount(toolGroup.name);
            const totalMethodsCount = toolGroup.methods.filter(m => m.visible !== false).length;
            const IconComponent = getIconComponent(toolGroup.icon);
            const hasGranular = hasGranularControl(toolGroup.name, toolsData);

            return (
              <SpotlightCard key={toolGroup.name} className="bg-card border border-border w-full min-w-0 max-w-full overflow-hidden">
                <div className="p-5 w-full box-border" style={{ maxWidth: '100%' }}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-card border border-border/50 flex-shrink-0">
                        <IconComponent className="h-5 w-5 text-foreground" />
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium text-foreground truncate">
                            {toolGroup.displayName}
                          </h4>
                          {toolGroup.isCore && (
                            <Badge variant="outline" className="text-xs">Core</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">
                          {toolGroup.description}
                        </p>
                        {hasGranular && isGroupEnabled && (
                          <button
                            onClick={() => toggleGroupExpansion(toolGroup.name)}
                            className="flex items-center gap-1 mt-1 hover:opacity-80 transition-opacity"
                          >
                            <p className="text-xs text-muted-foreground">
                              {enabledMethodsCount} / {totalMethodsCount} capabilities enabled
                            </p>
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                      <Checkbox
                        checked={isGroupEnabled}
                        onCheckedChange={(enabled) => handleToolGroupToggle(toolGroup.name, enabled === true)}
                        disabled={disabled || isLoading}
                      />
                    </div>
                  </div>

                  {hasGranular && isGroupEnabled && isExpanded && (
                    <div className="w-full overflow-hidden">
                      <div className="mt-4 pt-4 border-t w-full">
                        <div className="space-y-3 w-full">
                          {toolGroup.methods
                            .filter(method => method.visible !== false) // Only show visible methods
                            .map((method) => {
                              const isMethodEnabledState = isMethodEnabled(toolGroup.name, method.name);

                              return (
                                <div key={method.name} className="flex items-center justify-between w-full">
                                  <div className="flex items-center gap-4 flex-1 min-w-0 ml-16">
                                    <div className="flex-1 min-w-0 overflow-hidden">
                                      <div className="flex items-center gap-2 w-full overflow-hidden">
                                        <h5 className="text-sm font-medium truncate">
                                          {method.displayName}
                                        </h5>
                                        {method.isCore && (
                                          <Badge variant="outline" className="text-xs flex-shrink-0">Core</Badge>
                                        )}
                                      </div>
                                      <p className="text-xs text-muted-foreground truncate w-full">
                                        {method.description}
                                      </p>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                                    <Checkbox
                                      checked={isMethodEnabledState}
                                      onCheckedChange={(enabled) =>
                                        handleMethodToggle(toolGroup.name, method.name, enabled === true)
                                      }
                                      disabled={disabled || isLoading}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </SpotlightCard>
            );
          })}
        </div>
      </div>
    </div>
  );
};
