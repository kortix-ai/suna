/**
 * Tools Screen Component
 *
 * Allows configuring agentpress tools for a worker
 * Supports granular tool configuration with expandable capabilities
 */

import React, { useState, useEffect, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Alert, ScrollView, Image } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { useToolsMetadata, type ToolMetadata, type ToolMethod } from '@/hooks/useToolsMetadata';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Wrench,
  Save,
  AlertCircle,
  Check,
  ChevronRight,
  ChevronDown,
  FileText,
  Terminal,
  Folder,
  ListTodo,
  Image as ImageIcon,
  Globe,
  Presentation,
  Code,
  File,
  FileCode,
  Database,
  Settings,
  Zap,
  Search,
  Mail,
  Calendar,
  Clock,
  Users,
  MessageSquare,
  Video,
  Music,
  Camera,
  Palette,
  BarChart,
  PieChart,
  TrendingUp,
  ShoppingCart,
  CreditCard,
  Map,
  Navigation,
  Plane,
  Car,
  Home,
  Building,
  Briefcase,
  Book,
  GraduationCap,
  Heart,
  Star,
  Bell,
  Lock,
  Key,
  Shield,
  Eye,
  EyeOff,
  Download,
  Upload,
  Share,
  Link,
  Copy,
  Edit,
  Trash,
  Plus,
  Minus,
  X,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  HelpCircle,
  ExternalLink,
  ArrowRight,
  ArrowLeft,
  ChevronUp,
  ChevronDown as ChevronDownIcon,
  MoreVertical,
  MoreHorizontal,
} from 'lucide-react-native';
import { SvgUri } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import { EmptyState } from '@/components/shared/EmptyState';
import { log } from '@/lib/logger';

interface ToolsScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

export function ToolsScreen({ agentId, onUpdate }: ToolsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const { data: agent, isLoading } = useAgent(agentId);
  const { data: toolsMetadata, isLoading: isLoadingMetadata } = useToolsMetadata();
  const updateAgentMutation = useUpdateAgent();
  const [tools, setTools] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

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
    const toolGroup = toolsData?.[toolName];

    if (typeof currentConfig === 'object' && currentConfig !== null) {
      updatedTools[toolName] = {
        ...currentConfig,
        enabled,
      };
    } else if (toolGroup && hasGranularControl(toolName)) {
      // Convert to granular format when tool has methods
      updatedTools[toolName] = {
        enabled,
        methods:
          toolGroup.methods?.reduce(
            (acc, method) => {
              if (method.visible !== false) {
                acc[method.name] = method.enabled;
              }
              return acc;
            },
            {} as Record<string, boolean>
          ) || {},
      };
    } else {
      updatedTools[toolName] = enabled;
    }

    setTools(updatedTools);
    setHasChanges(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Toggle individual method/capability
  const handleMethodToggle = (toolName: string, methodName: string, enabled: boolean) => {
    if (!areToolsEditable) return;

    const toolGroup = toolsData?.[toolName];
    if (!toolGroup) return;

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
        enabled: isToolEnabled(toolName),
        methods: {
          ...(toolGroup.methods?.reduce(
            (acc, method) => {
              if (method.visible !== false) {
                acc[method.name] = method.name === methodName ? enabled : method.enabled;
              }
              return acc;
            },
            {} as Record<string, boolean>
          ) || {}),
        },
      };
    }

    setTools(updatedTools);
    setHasChanges(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Toggle group expansion
  const toggleGroupExpansion = (toolName: string) => {
    const newExpanded = new Set(expandedGroups);
    if (newExpanded.has(toolName)) {
      newExpanded.delete(toolName);
    } else {
      newExpanded.add(toolName);
    }
    setExpandedGroups(newExpanded);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // Check if tool has granular control (multiple methods)
  const hasGranularControl = (toolName: string): boolean => {
    const toolGroup = toolsData?.[toolName];
    if (!toolGroup) return false;
    const visibleMethods = toolGroup.methods?.filter((m) => m.visible !== false) || [];
    return visibleMethods.length > 0;
  };

  // Check if individual method is enabled
  const isMethodEnabled = (toolName: string, methodName: string): boolean => {
    const toolConfig = tools[toolName];
    if (!isToolEnabled(toolName)) return false;

    if (typeof toolConfig === 'boolean') return toolConfig;
    if (typeof toolConfig === 'object' && toolConfig !== null) {
      const methodsConfig = toolConfig.methods || {};
      const methodConfig = methodsConfig[methodName];

      if (typeof methodConfig === 'boolean') return methodConfig;
      if (typeof methodConfig === 'object' && methodConfig !== null) {
        return methodConfig.enabled ?? true;
      }

      // Default to method's default enabled state from tool group
      const toolGroup = toolsData?.[toolName];
      const method = toolGroup?.methods?.find((m) => m.name === methodName);
      return method?.enabled ?? true;
    }
    return false;
  };

  const handleSave = async () => {
    if (!hasChanges) return;

    const isSunaAgent = agent?.metadata?.is_suna_default || false;
    const restrictions = agent?.metadata?.restrictions || {};
    const areToolsEditable = restrictions.tools_editable !== false && !isSunaAgent;

    if (!areToolsEditable) {
      if (isSunaAgent) {
        Alert.alert(t('workers.cannotEditTools'), t('workers.sunaToolsManagedAlert'));
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
      log.error('Failed to update tools:', error);
      Alert.alert(t('common.error'), error?.message || t('common.errorOccurred'));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  // Get icon component from icon name or URL
  // Handles both Lucide icon names and SVG/image URLs
  const getIconComponent = (iconName?: string) => {
    if (!iconName) return Wrench;

    // Check if it's a URL (SVG or image)
    if (iconName.startsWith('http://') || iconName.startsWith('https://')) {
      return null; // Will be handled separately as URL
    }

    // Extended icon mappings - matches common Lucide icon names
    const iconMap: Record<string, any> = {
      // File & Document icons
      Wrench,
      FileText,
      File,
      FileCode,
      Terminal,
      Folder,
      ListTodo,
      FolderOpen: Folder,
      CheckSquare: ListTodo,
      Code: Terminal,

      // Media icons
      Image: ImageIcon,
      ImageIcon,
      Camera,
      Video,
      Music,

      // Web & Browser icons
      Globe,
      Search,
      ExternalLink,
      Link,

      // Presentation & Document icons
      Presentation,
      Book,

      // Data & Chart icons
      Database,
      BarChart,
      PieChart,
      TrendingUp,

      // UI & Settings icons
      Settings,
      Zap,
      Bell,
      Lock,
      Key,
      Shield,
      Eye,
      EyeOff,

      // Action icons
      Download,
      Upload,
      Share,
      Copy,
      Edit,
      Trash,
      Plus,
      Minus,
      X,

      // Status icons
      CheckCircle,
      XCircle,
      AlertTriangle,
      Info,
      HelpCircle,

      // Navigation icons
      ArrowRight,
      ArrowLeft,
      ChevronUp,
      ChevronDown: ChevronDownIcon,
      MoreVertical,
      MoreHorizontal,

      // Communication icons
      Mail,
      MessageSquare,
      Users,

      // Time & Calendar icons
      Calendar,
      Clock,

      // Business icons
      ShoppingCart,
      CreditCard,
      Building,
      Briefcase,
      Home,

      // Education icons
      GraduationCap,

      // Other icons
      Heart,
      Star,
      Map,
      Navigation,
      Plane,
      Car,
      Palette,
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

  // Render icon - handles both Lucide icons and URLs
  const renderIcon = (iconName?: string, size: number = 20) => {
    if (!iconName) {
      return <Icon as={Wrench} size={size} className="text-foreground" />;
    }

    // Check if it's a URL
    if (iconName.startsWith('http://') || iconName.startsWith('https://')) {
      const isSvg = iconName.toLowerCase().endsWith('.svg') || iconName.includes('.svg');
      const isPng = iconName.toLowerCase().endsWith('.png');

      if (isSvg) {
        return <SvgUri uri={iconName} width={size} height={size} />;
      } else {
        return (
          <Image
            source={{ uri: iconName }}
            style={{ width: size, height: size }}
            resizeMode="contain"
          />
        );
      }
    }

    // It's a Lucide icon name
    const IconComponent = getIconComponent(iconName);
    return <Icon as={IconComponent} size={size} className="text-foreground" />;
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
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">
          {t('workers.loadingTools')}
        </Text>
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ flex: 1, position: 'relative' }}>
      <View className="flex-row items-center justify-between">
        <View className="flex-1">
          <Text className="mb-2 font-roobert-semibold text-base text-foreground">
            {t('workers.toolConfiguration')}
          </Text>
          <Text className="mb-4 font-roobert text-sm text-muted-foreground">
            {t('workers.configureToolsDescription')}
          </Text>
        </View>
        <View className="rounded-full bg-primary/10 px-3 py-1.5">
          <Text className="font-roobert-medium text-xs text-primary">
            {t('workers.toolsEnabled', {
              enabled: enabledToolsCount,
              total: sortedToolGroups.length,
            })}
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
                  {isSunaAgent ? t('workers.sunaToolsManaged') : t('workers.toolsNotEditable')}
                </Text>
              </View>
            )}

            {sortedToolGroups.length === 0 ? (
              <EmptyState
                icon={Wrench}
                title={t('workers.noToolsAvailable')}
                description={t('workers.toolsWillAppear')}
              />
            ) : (
              <View className="gap-3">
                {sortedToolGroups.map((toolGroup) => {
                  const isEnabled = isToolEnabled(toolGroup.name);
                  const enabledMethodsCount = getEnabledMethodsCount(toolGroup.name);
                  const visibleMethods =
                    toolGroup.methods?.filter((m) => m.visible !== false) || [];
                  const totalMethodsCount = visibleMethods.length;
                  const hasCapabilities = totalMethodsCount > 0;
                  const isExpanded = expandedGroups.has(toolGroup.name);

                  return (
                    <View
                      key={toolGroup.name}
                      className="overflow-hidden rounded-2xl border border-border bg-card">
                      {/* Tool Header */}
                      <View className="flex-row items-start justify-between p-4">
                        <View className="min-w-0 flex-1 flex-row items-start gap-4">
                          <View className="h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-border/50 bg-card">
                            {renderIcon(toolGroup.icon, 20)}
                          </View>

                          <View className="min-w-0 flex-1">
                            <View className="mb-1 flex-row flex-wrap items-center gap-2">
                              <Text className="font-roobert-medium text-base text-foreground">
                                {toolGroup.display_name || toolGroup.name}
                              </Text>
                              {toolGroup.is_core && (
                                <View className="rounded-full border border-border bg-muted/50 px-2 py-0.5">
                                  <Text className="font-roobert-medium text-xs text-muted-foreground">
                                    {t('workers.core')}
                                  </Text>
                                </View>
                              )}
                            </View>
                            <Text className="mb-1 text-sm text-muted-foreground">
                              {toolGroup.description}
                            </Text>
                            {hasCapabilities && isEnabled && (
                              <Pressable
                                onPress={() => toggleGroupExpansion(toolGroup.name)}
                                className="mt-1 flex-row items-center gap-1 active:opacity-70">
                                <Text className="text-xs text-muted-foreground">
                                  {t('workers.capabilitiesEnabled', {
                                    enabled: enabledMethodsCount,
                                    total: totalMethodsCount,
                                  })}
                                </Text>
                                <Icon
                                  as={isExpanded ? ChevronDown : ChevronRight}
                                  size={12}
                                  className="text-muted-foreground"
                                />
                              </Pressable>
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
                      </View>

                      {/* Expanded Methods/Capabilities */}
                      {hasCapabilities && isEnabled && isExpanded && (
                        <View className="border-t border-border bg-muted/20 px-4 py-3">
                          <View className="gap-3">
                            {visibleMethods.map((method) => {
                              const isMethodEnabledState = isMethodEnabled(
                                toolGroup.name,
                                method.name
                              );

                              return (
                                <Pressable
                                  key={method.name}
                                  onPress={() =>
                                    areToolsEditable &&
                                    handleMethodToggle(
                                      toolGroup.name,
                                      method.name,
                                      !isMethodEnabledState
                                    )
                                  }
                                  disabled={!areToolsEditable || updateAgentMutation.isPending}
                                  className="flex-row items-start justify-between active:opacity-70">
                                  <View className="min-w-0 flex-1 pl-16">
                                    <View className="mb-0.5 flex-row items-center gap-2">
                                      <Text className="font-roobert-medium text-sm text-foreground">
                                        {method.display_name || method.name}
                                      </Text>
                                      {method.is_core && (
                                        <View className="rounded-full border border-border bg-muted/50 px-1.5 py-0.5">
                                          <Text className="font-roobert-medium text-[10px] text-muted-foreground">
                                            {t('workers.core')}
                                          </Text>
                                        </View>
                                      )}
                                    </View>
                                    <Text
                                      className="text-xs text-muted-foreground"
                                      numberOfLines={3}
                                      ellipsizeMode="tail">
                                      {method.description}
                                    </Text>
                                  </View>

                                  <View className="ml-4 mt-0.5 flex-shrink-0">
                                    <View
                                      className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
                                        isMethodEnabledState
                                          ? 'border-primary bg-primary'
                                          : 'border-muted-foreground/30 bg-transparent'
                                      }`}>
                                      {isMethodEnabledState && (
                                        <Icon
                                          as={Check}
                                          size={12}
                                          className="text-primary-foreground"
                                          strokeWidth={3}
                                        />
                                      )}
                                    </View>
                                  </View>
                                </Pressable>
                              );
                            })}
                          </View>
                        </View>
                      )}
                    </View>
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
                {updateAgentMutation.isPending
                  ? t('workers.savingChanges')
                  : t('workers.saveChanges')}
              </Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}
