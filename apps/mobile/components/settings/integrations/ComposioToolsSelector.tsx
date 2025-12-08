import * as React from 'react';
import { View, Pressable, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import {
  ArrowLeft,
  CheckCircle2,
  Search,
  AlertCircle
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import {
  useComposioTools,
  useUpdateComposioTools,
  type ComposioApp,
  type ComposioProfile,
  type ComposioTool
} from '@/hooks/useComposio';
import { useAgent, agentKeys } from '@/lib/agents/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { ToolkitIcon } from './ToolkitIcon';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ComposioToolsContentProps {
  app: ComposioApp;
  profile: ComposioProfile;
  agentId: string;
  onBack?: () => void;
  onComplete: () => void;
  noPadding?: boolean;
}

export function ComposioToolsContent({
  app,
  profile,
  agentId,
  onBack,
  onComplete,
  noPadding = false
}: ComposioToolsContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const queryClient = useQueryClient();
  const { data: toolsData, isLoading, error, refetch } = useComposioTools(profile.profile_id);
  const { mutate: updateTools, isPending: isSaving } = useUpdateComposioTools();
  const { data: agent } = useAgent(agentId);

  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());

  const tools = toolsData?.tools || [];

  // Load current enabled tools from agent when component mounts or agent/profile/tools change
  React.useEffect(() => {
    if (!agentId || !profile?.profile_id || !agent || isLoading || tools.length === 0) {
      // Don't try to load if tools aren't ready yet
      if (!isLoading && tools.length === 0 && agent) {
        // Tools loaded but empty - reset selection
        setSelectedTools(new Set());
      }
      return;
    }

    try {
      // Find the composio MCP with matching profile_id
      const composioMcps = agent.custom_mcps?.filter((mcp: any) =>
        mcp.type === 'composio' && mcp.config?.profile_id === profile.profile_id
      ) || [];

      // Extract enabled tools from all matching MCPs
      const enabledTools = composioMcps.flatMap((mcp: any) => mcp.enabledTools || []);

      // Backend stores tool slugs in enabledTools
      // Store slugs directly (like frontend does) for consistency
      if (enabledTools.length > 0) {
        // Filter to only include slugs that exist in the available tools
        const validEnabledTools = enabledTools.filter((enabledToolSlug: string) => {
          const tool = tools.find((t: ComposioTool) =>
            t.slug === enabledToolSlug ||
            t.slug?.toLowerCase() === enabledToolSlug?.toLowerCase() ||
            t.name === enabledToolSlug ||
            t.name?.toLowerCase() === enabledToolSlug?.toLowerCase()
          );
          return !!tool;
        });

        // Normalize slugs - use the actual slug from the tool object
        const normalizedSlugs = new Set(
          validEnabledTools.map((enabledToolSlug: string) => {
            const tool = tools.find((t: ComposioTool) =>
              t.slug === enabledToolSlug ||
              t.slug?.toLowerCase() === enabledToolSlug?.toLowerCase() ||
              t.name === enabledToolSlug ||
              t.name?.toLowerCase() === enabledToolSlug?.toLowerCase()
            );
            return tool?.slug || enabledToolSlug;
          }).filter(Boolean)
        );

        setSelectedTools(normalizedSlugs);
      } else {
        setSelectedTools(new Set());
      }
    } catch (error) {
      console.error('Failed to load current tools:', error);
      setSelectedTools(new Set());
    }
  }, [agentId, profile?.profile_id, agent, tools, isLoading]);

  const handleToolToggle = React.useCallback((toolSlug: string) => {
    setSelectedTools(prev => {
      const newSet = new Set(prev);
      if (newSet.has(toolSlug)) {
        newSet.delete(toolSlug);
      } else {
        newSet.add(toolSlug);
      }
      return newSet;
    });
  }, []);

  const handleSelectAll = React.useCallback(() => {
    if (selectedTools.size === tools.length) {
      setSelectedTools(new Set());
    } else {
      setSelectedTools(new Set(tools.map((tool: ComposioTool) => tool.slug)));
    }
  }, [tools, selectedTools.size]);

  const handleSaveTools = React.useCallback(() => {
    if (!agentId) return;

    // selectedTools already contains slugs, use them directly
    const selectedToolSlugs = Array.from(selectedTools).filter(Boolean);

    updateTools({
      agentId,
      profileId: profile.profile_id,
      selectedTools: selectedToolSlugs
    }, {
      onSuccess: (data) => {
        Alert.alert(t('integrations.connectionSuccess'), t('integrations.toolsSelector.toolsAddedSuccess', { count: selectedTools.size, app: app.name }));
        // Invalidate agent query to refresh the enabled tools count
        queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
        // Also invalidate the list to ensure consistency
        queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
        onComplete();
      },
      onError: (error: any) => {
        Alert.alert(t('integrations.connectionError'), error.message || t('integrations.toolsSelector.failedToSaveTools'));
      }
    });
  }, [agentId, profile.profile_id, selectedTools, updateTools, app.name, onComplete, t]);

  return (
    <View className="flex-1" style={{ flex: 1, position: 'relative' }}>
      {/* Header with back button, title, and description */}
      <View className="flex-row items-center mb-4">
        {onBack && (
          <Pressable
            onPress={onBack}
            className="flex-row items-center active:opacity-70"
          >
            <ArrowLeft
              size={20}
              color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'}
            />
          </Pressable>
        )}
        <View className="flex-1 ml-3">
          <Text
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="text-xl font-roobert-semibold"
          >
            {app.name}
          </Text>
          <Text
            style={{ color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)' }}
            className="text-sm font-roobert"
          >
            {profile.profile_name}
          </Text>
        </View>
      </View>

      {/* Scrollable content */}
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 90 }}
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}>
        <View className={noPadding ? "" : "px-0"}>
          <View className="flex-row items-center justify-between mb-6">
            <Text className="text-sm font-roobert-medium text-muted-foreground uppercase tracking-wider">
              {t('integrations.toolsSelector.selected', { count: selectedTools.size, total: tools.length, plural: selectedTools.size !== 1 ? 's' : '' })}
            </Text>
            <Pressable
              onPress={handleSelectAll}
              className="px-4 py-2 rounded-full bg-muted/10 active:opacity-70"
            >
              <Text className="text-sm font-roobert-semibold text-foreground">
                {selectedTools.size === tools.length ? t('integrations.toolsSelector.deselectAll') : t('integrations.toolsSelector.selectAll')}
              </Text>
            </Pressable>
          </View>
          {isLoading ? (
            <View className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <View
                  key={i}
                  className="rounded-2xl border border-border bg-card p-4">
                  <View className="flex-row items-center gap-3">
                    <View className="h-12 w-12 rounded-xl bg-muted" />
                    <View className="flex-1 space-y-2">
                      <View className="h-4 w-3/4 rounded bg-muted" />
                      <View className="h-3 w-full rounded bg-muted" />
                    </View>
                    <View className="h-6 w-6 rounded-full bg-muted" />
                  </View>
                </View>
              ))}
            </View>
          ) : error ? (
            <View className="items-center py-8">
              <Icon as={AlertCircle} size={48} className="text-destructive/40" />
              <Text className="text-lg font-roobert-medium text-foreground mt-4">
                Failed to Load Tools
              </Text>
              <Text className="text-sm font-roobert text-muted-foreground text-center mt-2">
                {error.message}
              </Text>
              <Pressable
                onPress={() => refetch()}
                className="mt-4 px-4 py-2 bg-primary rounded-xl"
              >
                <Text className="text-sm font-roobert-medium text-white">
                  Retry
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="space-y-3 mb-6">
            {tools.length > 0 ? (
              tools.map((tool: ComposioTool, index: number) => (
                <ToolCard
                  key={tool.slug || tool.name || index}
                  tool={tool}
                  selected={selectedTools.has(tool.slug)}
                  onToggle={() => handleToolToggle(tool.slug)}
                />
              ))
              ) : (
                <View className="items-center py-12 px-6">
                  <Icon as={Search} size={48} className="text-muted-foreground/40" />
                  <Text className="text-lg font-roobert-medium text-foreground mt-4">
                    {t('integrations.toolsSelector.noToolsAvailable')}
                  </Text>
                  <Text className="text-sm font-roobert text-muted-foreground text-center">
                    {t('integrations.toolsSelector.noToolsDescription')}
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {/* Sticky floating button at bottom - positioned absolutely */}
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          paddingHorizontal: 16,
          paddingBottom: 16,
          paddingTop: 8,
          backgroundColor: colorScheme === 'dark' ? '#18181B' : '#FFFFFF',
          borderTopWidth: 1,
          borderTopColor: colorScheme === 'dark' ? '#27272A' : '#E4E4E7',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.1,
          shadowRadius: 8,
          elevation: 8,
          zIndex: 10,
        }}>
        <ContinueButton
          onPress={handleSaveTools}
          disabled={selectedTools.size === 0 || isSaving}
          isLoading={isSaving}
          label={isSaving ? t('integrations.toolsSelector.addingTools') : selectedTools.size === 0 ? t('integrations.toolsSelector.selectTools') : selectedTools.size === 1 ? t('integrations.toolsSelector.addTool', { count: selectedTools.size }) : t('integrations.toolsSelector.addTools', { count: selectedTools.size })}
          rounded="full"
        />
      </View>
    </View>
  );
}

interface ToolCardProps {
  tool: ComposioTool;
  selected: boolean;
  onToggle: () => void;
}

interface ContinueButtonProps {
  onPress: () => void;
  disabled?: boolean;
  label: string;
  isLoading?: boolean;
  rounded?: 'full' | '2xl';
}

const ContinueButton = React.memo(({
  onPress,
  disabled = false,
  label,
  isLoading = false,
  rounded = 'full'
}: ContinueButtonProps) => {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = React.useCallback(() => {
    if (!disabled) {
      scale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
    }
  }, [scale, disabled]);

  const handlePressOut = React.useCallback(() => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  }, [scale]);

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      disabled={disabled}
      className={`w-full py-4 items-center ${rounded === 'full' ? 'rounded-full' : 'rounded-2xl'} ${disabled ? 'bg-muted/20' : 'bg-foreground'
        }`}
    >
      <View className="flex-row items-center gap-2">
        {isLoading && <ActivityIndicator size="small" color="#fff" />}
        <Text className={`text-base font-roobert-semibold ${disabled ? 'text-muted-foreground' : 'text-background'
          }`}>
          {label}
        </Text>
      </View>
    </AnimatedPressable>
  );
});

const ToolCard = React.memo(({ tool, selected, onToggle }: ToolCardProps) => {
  return (
    <Pressable
      onPress={onToggle}
      className={`flex-row items-start gap-3 p-4 rounded-3xl mb-2 active:opacity-80 ${selected
          ? 'bg-primary/10'
          : 'bg-muted/5'
        }`}
    >
      <View className={`w-6 h-6 rounded-full items-center justify-center mt-0.5 ${selected ? 'bg-primary' : 'bg-transparent border-2 border-muted-foreground/30'
        }`}>
        {selected && (
          <Icon
            as={CheckCircle2}
            size={16}
            className="text-primary-foreground"
            strokeWidth={2.5}
          />
        )}
      </View>

      <View className="flex-1">
        <Text className="font-roobert-semibold text-foreground mb-1">
          {tool.name}
        </Text>
        <Text
          className="text-sm font-roobert text-muted-foreground leading-relaxed"
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {tool.description}
        </Text>
      </View>
    </Pressable>
  );
});
