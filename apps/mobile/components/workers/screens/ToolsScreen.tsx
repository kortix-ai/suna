/**
 * Tools Screen Component
 *
 * Allows configuring agentpress tools for a worker
 * Simplified version - full granular tool configuration can be added later
 */

import React, { useState, useEffect, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { useToolsMetadata, type ToolMetadata } from '@/hooks/useToolsMetadata';
import {
  Wrench,
  Save,
  AlertCircle,
  Check,
  ChevronRight,
  FileText,
  Terminal,
  Folder,
  ListTodo,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';

interface ToolsScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

export function ToolsScreen({ agentId, onUpdate }: ToolsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { data: agent, isLoading } = useAgent(agentId);
  const { data: toolsMetadata, isLoading: isLoadingMetadata } = useToolsMetadata();
  const updateAgentMutation = useUpdateAgent();
  const [tools, setTools] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const toolsData = toolsMetadata?.success ? toolsMetadata.tools : undefined;

  useEffect(() => {
    if (agent?.agentpress_tools) {
      setTools(agent.agentpress_tools);
      setHasChanges(false);
    }
  }, [agent?.agentpress_tools]);

  const isSunaAgent = agent?.metadata?.is_suna_default || false;
  const restrictions = agent?.metadata?.restrictions || {};
  const areToolsEditable = restrictions.tools_editable !== false && !isSunaAgent;

  const handleToolToggle = (toolName: string, enabled: boolean) => {
    if (!areToolsEditable) return;

    const updatedTools = { ...tools };
    const currentConfig = tools[toolName];

    if (typeof currentConfig === 'object' && currentConfig !== null) {
      updatedTools[toolName] = {
        ...currentConfig,
        enabled,
      };
    } else {
      updatedTools[toolName] = enabled;
    }

    setTools(updatedTools);
    setHasChanges(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleSave = async () => {
    if (!hasChanges) return;

    const isSunaAgent = agent?.metadata?.is_suna_default || false;
    const restrictions = agent?.metadata?.restrictions || {};
    const areToolsEditable = restrictions.tools_editable !== false && !isSunaAgent;

    if (!areToolsEditable) {
      if (isSunaAgent) {
        Alert.alert('Cannot Edit', "Suna's tools are managed centrally.");
      }
      return;
    }

    try {
      await updateAgentMutation.mutateAsync({
        agentId,
        data: {
          agentpress_tools: tools,
        },
      });
      setHasChanges(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onUpdate?.();
    } catch (error: any) {
      console.error('Failed to update tools:', error);
      Alert.alert('Error', error?.message || 'Failed to update tools');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // Get icon component from icon name
  // Maps icon names from backend to lucide-react-native icons
  const getIconComponent = (iconName?: string) => {
    if (!iconName) return Wrench;

    // Common icon mappings - can be extended
    const iconMap: Record<string, any> = {
      Wrench,
      FileText,
      Terminal,
      Folder,
      ListTodo,
      File: FileText,
      FolderOpen: Folder,
      CheckSquare: ListTodo,
      Code: Terminal,
    };

    // Try exact match first
    if (iconMap[iconName]) {
      return iconMap[iconName];
    }

    // Try case-insensitive match
    const lowerName = iconName.toLowerCase();
    for (const [key, value] of Object.entries(iconMap)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }

    // Default fallback
    return Wrench;
  };

  // Check if tool is enabled
  const isToolEnabled = (toolName: string): boolean => {
    const toolConfig = tools[toolName];
    if (toolConfig === undefined) return false;
    if (typeof toolConfig === 'boolean') return toolConfig;
    if (typeof toolConfig === 'object' && toolConfig !== null) {
      return toolConfig.enabled ?? true;
    }
    return false;
  };

  // Get enabled methods count for a tool
  const getEnabledMethodsCount = (toolName: string): number => {
    const toolGroup = toolsData?.[toolName];
    if (!toolGroup) return 0;

    const toolConfig = tools[toolName];
    if (!isToolEnabled(toolName)) return 0;

    if (typeof toolConfig === 'boolean') {
      // All methods enabled if tool is enabled
      return toolGroup.methods?.filter((m) => m.visible !== false && m.enabled).length || 0;
    }

    if (typeof toolConfig === 'object' && toolConfig !== null) {
      const methodsConfig = toolConfig.methods || {};
      let count = 0;

      for (const method of toolGroup.methods || []) {
        if (method.visible === false) continue;

        let methodEnabled = method.enabled;
        if (method.name in methodsConfig) {
          const methodConfig = methodsConfig[method.name];
          if (typeof methodConfig === 'boolean') {
            methodEnabled = methodConfig;
          } else if (typeof methodConfig === 'object' && methodConfig !== null) {
            methodEnabled = methodConfig.enabled ?? method.enabled;
          }
        }

        if (methodEnabled) count++;
      }

      return count;
    }

    return toolGroup.methods?.filter((m) => m.visible !== false && m.enabled).length || 0;
  };

  // Get sorted and filtered tool groups
  const sortedToolGroups = useMemo(() => {
    if (!toolsData) return [];

    const groups = Object.values(toolsData)
      .filter((tool) => tool.visible !== false)
      .sort((a, b) => (a.weight || 100) - (b.weight || 100));

    return groups;
  }, [toolsData]);

  const enabledToolsCount = useMemo(() => {
    return sortedToolGroups.filter((tool) => isToolEnabled(tool.name)).length;
  }, [sortedToolGroups, tools]);

  if (isLoading || isLoadingMetadata) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">Loading tools...</Text>
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ flex: 1, position: 'relative' }}>
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="mb-2 font-roobert-semibold text-base text-foreground">
            Tool Configuration
          </Text>
          <Text className="mb-4 font-roobert text-sm text-muted-foreground">
            Configure tools and their individual capabilities for your agent
          </Text>
        </View>
        <View className="rounded-full bg-primary/10 px-3 py-1.5">
          <Text className="font-roobert-medium text-xs text-primary">
            {enabledToolsCount} / {sortedToolGroups.length} enabled
          </Text>
        </View>
      </View>

      <View className="mb-4 flex-1 gap-4">
        <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
          <View className="space-y-4">
            {!areToolsEditable && (
              <View className="mb-4 flex-row items-start gap-2 rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-3">
                <Icon
                  as={AlertCircle}
                  size={16}
                  className="mt-0.5 text-yellow-600 dark:text-yellow-400"
                />
                <Text className="flex-1 font-roobert text-sm text-yellow-600 dark:text-yellow-400">
                  {isSunaAgent
                    ? "Suna's tools are managed centrally and cannot be edited."
                    : 'These tools cannot be edited.'}
                </Text>
              </View>
            )}

            {sortedToolGroups.length === 0 ? (
              <View className="items-center justify-center rounded-2xl border border-border bg-card p-8">
                <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
                  <Icon as={Wrench} size={24} className="text-muted-foreground" />
                </View>
                <Text className="mb-1 font-roobert-semibold text-base text-foreground">
                  No tools available
                </Text>
                <Text className="text-center text-sm text-muted-foreground">
                  Tools will appear here once available
                </Text>
              </View>
            ) : (
              <View className="gap-3">
                {sortedToolGroups.map((toolGroup) => {
                  const isEnabled = isToolEnabled(toolGroup.name);
                  const enabledMethodsCount = getEnabledMethodsCount(toolGroup.name);
                  const totalMethodsCount =
                    toolGroup.methods?.filter((m) => m.visible !== false).length || 0;
                  const IconComponent = getIconComponent(toolGroup.icon);
                  const hasCapabilities = totalMethodsCount > 0;

                  return (
                    <Pressable
                      key={toolGroup.name}
                      onPress={() =>
                        areToolsEditable && handleToolToggle(toolGroup.name, !isEnabled)
                      }
                      disabled={!areToolsEditable}
                      className="flex-row items-start justify-between rounded-2xl border border-border bg-card p-4 active:opacity-80">
                      <View className="min-w-0 flex-1 flex-row items-start gap-4">
                        <View className="h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-border/50 bg-card">
                          <Icon as={IconComponent} size={20} className="text-foreground" />
                        </View>

                        <View className="min-w-0 flex-1">
                          <View className="mb-1 flex-row flex-wrap items-center gap-2">
                            <Text className="font-roobert-medium text-base text-foreground">
                              {toolGroup.display_name || toolGroup.name}
                            </Text>
                            {toolGroup.is_core && (
                              <View className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                                <Text className="font-roobert-medium text-xs text-muted-foreground">
                                  Core
                                </Text>
                              </View>
                            )}
                          </View>
                          <Text className="mb-1 text-sm text-muted-foreground">
                            {toolGroup.description}
                          </Text>
                          {hasCapabilities && isEnabled && (
                            <View className="mt-1 flex-row items-center gap-1">
                              <Text className="text-xs text-muted-foreground">
                                {enabledMethodsCount} / {totalMethodsCount} capabilities enabled
                              </Text>
                              <Icon as={ChevronRight} size={12} className="text-muted-foreground" />
                            </View>
                          )}
                        </View>
                      </View>

                      <View className="ml-4 mt-1 flex-shrink-0">
                        <Pressable
                          onPress={() =>
                            areToolsEditable && handleToolToggle(toolGroup.name, !isEnabled)
                          }
                          disabled={!areToolsEditable || updateAgentMutation.isPending}
                          className={`h-6 w-6 items-center justify-center rounded-full border-2 ${
                            isEnabled
                              ? 'border-primary bg-primary'
                              : 'border-muted-foreground/30 bg-transparent'
                          }`}>
                          {isEnabled && (
                            <Icon
                              as={Check}
                              size={14}
                              className="text-primary-foreground"
                              strokeWidth={3}
                            />
                          )}
                        </Pressable>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>

        {/* Sticky button at bottom - always visible when editable */}
        {areToolsEditable && (
          <View
          // style={{
          //   position: 'absolute',
          //   bottom: 0,
          //   left: 0,
          //   right: 0,
          //   paddingBottom: 16,
          //   zIndex: 10,
          // }}
          >
            <Pressable
              onPress={handleSave}
              disabled={!hasChanges || updateAgentMutation.isPending}
              className={`flex-row items-center justify-center gap-2 rounded-xl p-4 ${
                !hasChanges || updateAgentMutation.isPending
                  ? 'bg-primary/50 opacity-50'
                  : 'bg-primary active:opacity-80'
              }`}>
              {updateAgentMutation.isPending ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Icon as={Save} size={18} className="text-primary-foreground" />
              )}
              <Text className="font-roobert-semibold text-base text-primary-foreground">
                {updateAgentMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
