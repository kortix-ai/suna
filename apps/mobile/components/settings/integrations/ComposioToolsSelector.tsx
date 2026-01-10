import * as React from 'react';
import { View, Pressable, ActivityIndicator, Alert, FlatList, TextInput } from 'react-native';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { CheckCircle2, Search, AlertCircle, Save, X, Pencil } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import {
  useComposioToolsBySlug,
  useUpdateComposioTools,
  type ComposioApp,
  type ComposioProfile,
  type ComposioTool,
} from '@/hooks/useComposio';
import { useAgent, agentKeys } from '@/lib/agents/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { ToolkitIcon } from './ToolkitIcon';
import { EmptyState } from '@/components/shared/EmptyState';
import { log } from '@/lib/logger';

interface ComposioToolsContentProps {
  app: ComposioApp;
  profile: ComposioProfile;
  agentId: string;
  onBack?: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  noPadding?: boolean;
  useBottomSheetFlatList?: boolean;
}

export function ComposioToolsContent({
  app,
  profile,
  agentId,
  onBack,
  onComplete,
  onEdit,
  noPadding = false,
  useBottomSheetFlatList = false,
}: ComposioToolsContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const queryClient = useQueryClient();
  const toolkitSlug = app.slug || profile.toolkit_slug || '';
  const {
    data: toolsData,
    isLoading,
    error,
    refetch,
  } = useComposioToolsBySlug(toolkitSlug, {
    limit: 10000, // Load all tools at once
    enabled: !!toolkitSlug,
  });
  const { mutate: updateTools, isPending: isSaving } = useUpdateComposioTools();
  const { data: agent } = useAgent(agentId);

  const [selectedTools, setSelectedTools] = React.useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = React.useState('');

  const allTools = toolsData?.tools || [];
  const totalTools = toolsData?.total_items ?? allTools.length;

  // Filter tools based on search query
  const filteredTools = React.useMemo(() => {
    if (!searchQuery.trim()) return allTools;
    const query = searchQuery.toLowerCase();
    return allTools.filter((tool: ComposioTool) => {
      const name = tool.name?.toLowerCase() || '';
      const description = tool.description?.toLowerCase() || '';
      const slug = tool.slug?.toLowerCase() || '';
      return name.includes(query) || description.includes(query) || slug.includes(query);
    });
  }, [allTools, searchQuery]);

  // Load current enabled tools from agent when component mounts or agent/profile/tools change
  React.useEffect(() => {
    if (!agentId || !profile?.profile_id || !agent || isLoading || allTools.length === 0) {
      // Don't try to load if tools aren't ready yet
      if (!isLoading && allTools.length === 0 && agent) {
        // Tools loaded but empty - reset selection
        setSelectedTools(new Set());
      }
      return;
    }

    try {
      // Find the composio MCP with matching profile_id
      const composioMcps =
        agent.custom_mcps?.filter(
          (mcp: any) => mcp.type === 'composio' && mcp.config?.profile_id === profile.profile_id
        ) || [];

      // Extract enabled tools from all matching MCPs
      const enabledTools = composioMcps.flatMap((mcp: any) => mcp.enabledTools || []);

      // Backend stores tool slugs in enabledTools (e.g., "GMAIL_CREATE_LABEL")
      // Match web version: use enabledTools directly, filter to only include tools that exist
      if (enabledTools.length > 0) {
        // Create a Set of all available tool slugs and names for quick lookup
        const availableSlugs = new Set(allTools.map((t: ComposioTool) => t.slug).filter(Boolean));
        const availableNames = new Set(allTools.map((t: ComposioTool) => t.name).filter(Boolean));

        // Create a map: slug -> identifier, name -> identifier
        const slugToIdentifier = new Map<string, string>();
        const nameToIdentifier = new Map<string, string>();
        allTools.forEach((tool: ComposioTool) => {
          const identifier = tool.slug || tool.name;
          if (tool.slug) {
            slugToIdentifier.set(tool.slug, identifier);
            slugToIdentifier.set(tool.slug.toLowerCase(), identifier);
          }
          if (tool.name) {
            nameToIdentifier.set(tool.name, identifier);
            nameToIdentifier.set(tool.name.toLowerCase(), identifier);
          }
        });

        // Match enabled tools to available tools
        const matchedIdentifiers = new Set<string>();
        enabledTools.forEach((enabledTool: string) => {
          if (!enabledTool) return;

          // Try exact slug match first
          if (availableSlugs.has(enabledTool)) {
            const identifier = slugToIdentifier.get(enabledTool);
            if (identifier) matchedIdentifiers.add(identifier);
            return;
          }

          // Try case-insensitive slug match
          const lowerEnabled = enabledTool.toLowerCase();
          if (slugToIdentifier.has(lowerEnabled)) {
            const identifier = slugToIdentifier.get(lowerEnabled);
            if (identifier) matchedIdentifiers.add(identifier);
            return;
          }

          // Try exact name match
          if (availableNames.has(enabledTool)) {
            const identifier = nameToIdentifier.get(enabledTool);
            if (identifier) matchedIdentifiers.add(identifier);
            return;
          }

          // Try case-insensitive name match
          if (nameToIdentifier.has(lowerEnabled)) {
            const identifier = nameToIdentifier.get(lowerEnabled);
            if (identifier) matchedIdentifiers.add(identifier);
          }
        });

        setSelectedTools(matchedIdentifiers);
      } else {
        setSelectedTools(new Set());
      }
    } catch (error) {
      log.error('Failed to load current tools:', error);
      setSelectedTools(new Set());
    }
  }, [agentId, profile?.profile_id, agent, allTools, isLoading]);

  const handleToolToggle = React.useCallback((toolSlug: string) => {
    setSelectedTools((prev) => {
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
    // Get all tool identifiers (slug or name as fallback) from filtered tools
    const toolIdentifiers = filteredTools
      .map((tool: ComposioTool) => tool.slug || tool.name)
      .filter(Boolean) as string[];

    // Check if all filtered tools are selected
    const allFilteredSelected =
      toolIdentifiers.length > 0 && toolIdentifiers.every((id) => selectedTools.has(id));

    if (allFilteredSelected) {
      // Deselect all filtered tools
      setSelectedTools((prev) => {
        const newSet = new Set(prev);
        toolIdentifiers.forEach((id) => newSet.delete(id));
        return newSet;
      });
    } else {
      // Select all filtered tools
      setSelectedTools((prev) => {
        const newSet = new Set(prev);
        toolIdentifiers.forEach((id) => newSet.add(id));
        return newSet;
      });
    }
  }, [filteredTools, selectedTools]);

  const handleSaveTools = React.useCallback(() => {
    if (!agentId) return;

    // Convert selected tool identifiers (slug or name) to slugs for backend
    // Backend expects slugs, so prioritize slug if available
    const selectedToolSlugs = Array.from(selectedTools)
      .map((identifier: string) => {
        // Find the tool by identifier
        const tool = allTools.find(
          (t: ComposioTool) => t.slug === identifier || t.name === identifier
        );
        // Prefer slug, fallback to identifier (name) if no slug exists
        return tool?.slug || identifier;
      })
      .filter(Boolean);

    updateTools(
      {
        agentId,
        profileId: profile.profile_id,
        selectedTools: selectedToolSlugs,
      },
      {
        onSuccess: (data) => {
          Alert.alert(
            t('integrations.connectionSuccess'),
            t('integrations.toolsSelector.toolsAddedSuccess', {
              count: selectedTools.size,
              app: app.name,
            })
          );
          // Invalidate agent query to refresh the enabled tools count
          queryClient.invalidateQueries({ queryKey: agentKeys.detail(agentId) });
          // Also invalidate the list to ensure consistency
          queryClient.invalidateQueries({ queryKey: agentKeys.lists() });
          onComplete();
        },
        onError: (error: any) => {
          Alert.alert(
            t('integrations.connectionError'),
            error.message || t('integrations.toolsSelector.failedToSaveTools')
          );
        },
      }
    );
  }, [agentId, profile.profile_id, selectedTools, updateTools, app.name, onComplete, t, allTools]);

  const ListComponent = useBottomSheetFlatList ? BottomSheetFlatList : FlatList;

  const renderToolItem = React.useCallback(
    ({ item: tool }: { item: ComposioTool }) => {
      const toolIdentifier = tool.slug || tool.name || '';
      return (
        <View style={useBottomSheetFlatList ? { paddingHorizontal: 24, marginBottom: 4 } : { marginBottom: 4 }}>
          <ToolCard
            tool={tool}
            selected={selectedTools.has(toolIdentifier)}
            onToggle={() => handleToolToggle(toolIdentifier)}
          />
        </View>
      );
    },
    [selectedTools, handleToolToggle, useBottomSheetFlatList]
  );

  const listEmptyComponent = React.useMemo(
    () => (
      <View style={{ paddingHorizontal: useBottomSheetFlatList ? 24 : 0, paddingVertical: 32 }}>
        <EmptyState
          icon={Search}
          title={
            searchQuery
              ? t('integrations.toolsSelector.noToolsFound')
              : t('integrations.toolsSelector.noToolsAvailable')
          }
          description={
            searchQuery
              ? t('integrations.toolsSelector.tryAdjustingSearch')
              : t('integrations.toolsSelector.toolsAppearHere')
          }
        />
      </View>
    ),
    [searchQuery, t, useBottomSheetFlatList]
  );

  // Render with BottomSheetFlatList layout (fixed header + scrollable list + fixed footer)
  if (useBottomSheetFlatList) {
    return (
      <View style={{ flex: 1 }}>
        {/* Fixed Header */}
        <View
          style={{
            paddingHorizontal: 24,
            paddingTop: 16,
            paddingBottom: 16,
            backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
          }}>
          <Text
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="mb-1 font-roobert-semibold text-xl">
            {app.name || profile.toolkit_name || app.slug}
          </Text>
          <Text
            style={{
              color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
            }}
            className="mb-4 font-roobert text-sm">
            {profile.profile_name}
          </Text>

          {/* Search Bar */}
          <View
            className="flex-row items-center rounded-2xl border border-border bg-card px-4"
            style={{
              backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
              borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
            }}>
            <Icon as={Search} size={18} className="text-muted-foreground" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t('composio.searchTools')}
              placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
              className="ml-3 flex-1 py-3 font-roobert text-base text-foreground"
              style={{
                color: colorScheme === 'dark' ? '#F8F8F8' : '#121215',
              }}
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery('')} className="ml-2">
                <Icon as={X} size={18} className="text-muted-foreground" />
              </Pressable>
            )}
          </View>

          {/* Selection Info */}
          <View className="mt-4 flex-row items-center justify-between">
            <Text className="font-roobert-medium text-sm uppercase tracking-wider text-muted-foreground">
              {t('integrations.toolsSelector.selected', {
                count: selectedTools.size,
                total: totalTools,
                plural: selectedTools.size !== 1 ? 's' : '',
              })}
            </Text>
            <Pressable
              onPress={handleSelectAll}
              className="rounded-full bg-muted/10 px-4 py-2 active:opacity-70">
              <Text className="font-roobert-semibold text-sm text-foreground">
                {filteredTools.length > 0 &&
                filteredTools.every((tool: ComposioTool) => {
                  const id = tool.slug || tool.name;
                  return id && selectedTools.has(id);
                })
                  ? t('integrations.toolsSelector.deselectAll')
                  : t('integrations.toolsSelector.selectAll')}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Scrollable Tools List */}
        {isLoading && allTools.length === 0 ? (
          <View style={{ flex: 1, paddingHorizontal: 24 }}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <View key={i} className="mb-2 rounded-2xl border border-border bg-card p-4">
                <View className="flex-row items-center gap-3">
                  <View className="h-6 w-6 rounded-full bg-muted" />
                  <View className="flex-1 space-y-2">
                    <View className="h-4 w-3/4 rounded bg-muted" />
                    <View className="h-3 w-full rounded bg-muted" />
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : error ? (
          <View style={{ flex: 1, paddingHorizontal: 24 }} className="items-center justify-center">
            <Icon as={AlertCircle} size={48} className="text-destructive/40" />
            <Text className="mt-4 font-roobert-medium text-lg text-foreground">
              {t('composio.failedToLoadTools')}
            </Text>
            <Text className="mt-2 text-center font-roobert text-sm text-muted-foreground">
              {error.message}
            </Text>
            <Pressable onPress={() => refetch()} className="mt-4 rounded-xl bg-primary px-4 py-2">
              <Text className="font-roobert-medium text-sm text-white">{t('composio.retry')}</Text>
            </Pressable>
          </View>
        ) : (
          <BottomSheetFlatList
            data={filteredTools}
            keyExtractor={(item, index) => item.slug || item.name || `tool-${index}`}
            renderItem={renderToolItem}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingTop: 8, paddingBottom: 16, flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={listEmptyComponent}
          />
        )}

        {/* Fixed Footer Button */}
        <View
          style={{
            paddingHorizontal: 24,
            paddingTop: 16,
            paddingBottom: 24,
            backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
          }}>
          <Pressable
            onPress={handleSaveTools}
            disabled={selectedTools.size === 0 || isSaving}
            className={`flex-row items-center justify-center gap-2 rounded-xl p-4 ${
              selectedTools.size === 0 || isSaving
                ? 'bg-primary/50 opacity-50'
                : 'bg-primary active:opacity-80'
            }`}>
            {isSaving ? (
              <ActivityIndicator size="small" color="#FFFFFF" />
            ) : (
              <Icon as={Save} size={18} className="text-primary-foreground" />
            )}
            <Text className="font-roobert-semibold text-base text-primary-foreground">
              {isSaving
                ? t('composio.saving')
                : selectedTools.size === 0
                  ? t('composio.selectTools')
                  : selectedTools.size === 1
                    ? t('composio.saveTools', { count: 1 }).replace('Tools', 'Tool')
                    : t('composio.saveTools', { count: selectedTools.size })}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Regular layout (for non-BottomSheet usage)
  return (
    <View className="mb-4 flex-1" style={{ flex: 1, position: 'relative' }}>
      {/* Header with title, description and edit button */}
      <View className="mb-4 flex-row items-center justify-between">
        <View className="flex-1">
          <Text
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="font-roobert-semibold text-xl">
            {app.name || profile.toolkit_name || app.slug}
          </Text>
          <Text
            style={{
              color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
            }}
            className="font-roobert text-sm">
            {profile.profile_name}
          </Text>
        </View>
        {onEdit && (
          <Pressable
            onPress={onEdit}
            className="h-10 w-10 items-center justify-center rounded-xl bg-muted/10 active:opacity-70">
            <Icon as={Pencil} size={18} className="text-foreground" />
          </Pressable>
        )}
      </View>

      {/* Sticky Search Bar */}
      <View className="mb-4">
        <View
          className="flex-row items-center rounded-2xl border border-border bg-card px-4"
          style={{
            backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
            borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
          }}>
          <Icon as={Search} size={18} className="text-muted-foreground" />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('composio.searchTools')}
            placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
            className="ml-3 flex-1 py-3 font-roobert text-base text-foreground"
            style={{
              color: colorScheme === 'dark' ? '#F8F8F8' : '#121215',
            }}
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} className="ml-2">
              <Icon as={X} size={18} className="text-muted-foreground" />
            </Pressable>
          )}
        </View>
      </View>

      {/* Header with selection info */}
      <View className={noPadding ? '' : 'px-0'}>
        <View className="mb-4 flex-row items-center justify-between">
          <Text className="font-roobert-medium text-sm uppercase tracking-wider text-muted-foreground">
            {t('integrations.toolsSelector.selected', {
              count: selectedTools.size,
              total: totalTools,
              plural: selectedTools.size !== 1 ? 's' : '',
            })}
          </Text>
          <Pressable
            onPress={handleSelectAll}
            className="rounded-full bg-muted/10 px-4 py-2 active:opacity-70">
            <Text className="font-roobert-semibold text-sm text-foreground">
              {filteredTools.length > 0 &&
              filteredTools.every((tool: ComposioTool) => {
                const id = tool.slug || tool.name;
                return id && selectedTools.has(id);
              })
                ? t('integrations.toolsSelector.deselectAll')
                : t('integrations.toolsSelector.selectAll')}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Scrollable content with virtualization */}
      <View className="mb-4 flex-1">
        {isLoading && allTools.length === 0 ? (
          <View className="space-y-3">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
              <View key={i} className="rounded-2xl border border-border bg-card p-4">
                <View className="flex-row items-center gap-3">
                  <View className="h-6 w-6 rounded-full bg-muted" />
                  <View className="flex-1 space-y-2">
                    <View className="h-4 w-3/4 rounded bg-muted" />
                    <View className="h-3 w-full rounded bg-muted" />
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : error ? (
          <View className="items-center py-8">
            <Icon as={AlertCircle} size={48} className="text-destructive/40" />
            <Text className="mt-4 font-roobert-medium text-lg text-foreground">
              {t('composio.failedToLoadTools')}
            </Text>
            <Text className="mt-2 text-center font-roobert text-sm text-muted-foreground">
              {error.message}
            </Text>
            <Pressable onPress={() => refetch()} className="mt-4 rounded-xl bg-primary px-4 py-2">
              <Text className="font-roobert-medium text-sm text-white">{t('composio.retry')}</Text>
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={filteredTools}
            keyExtractor={(item, index) => item.slug || item.name || `tool-${index}`}
            renderItem={renderToolItem}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={50}
            initialNumToRender={20}
            windowSize={10}
            ListEmptyComponent={listEmptyComponent}
          />
        )}
      </View>

      {/* Sticky Save Button at bottom */}
      <View>
        <Pressable
          onPress={handleSaveTools}
          disabled={selectedTools.size === 0 || isSaving}
          className={`flex-row items-center justify-center gap-2 rounded-xl p-4 ${
            selectedTools.size === 0 || isSaving
              ? 'bg-primary/50 opacity-50'
              : 'bg-primary active:opacity-80'
          }`}>
          {isSaving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Icon as={Save} size={18} className="text-primary-foreground" />
          )}
          <Text className="font-roobert-semibold text-base text-primary-foreground">
            {isSaving
              ? t('composio.saving')
              : selectedTools.size === 0
                ? t('composio.selectTools')
                : selectedTools.size === 1
                  ? t('composio.saveTools', { count: 1 }).replace('Tools', 'Tool')
                  : t('composio.saveTools', { count: selectedTools.size })}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

interface ToolCardProps {
  tool: ComposioTool;
  selected: boolean;
  onToggle: () => void;
}

const ToolCard = React.memo(({ tool, selected, onToggle }: ToolCardProps) => {
  return (
    <Pressable
      onPress={onToggle}
      className={`mb-2 flex-row items-start gap-3 rounded-2xl p-4 active:opacity-80 ${
        selected ? 'bg-primary/10' : 'bg-muted/5'
      }`}>
      <View
        className={`mt-0.5 h-6 w-6 items-center justify-center rounded-full ${
          selected ? 'bg-primary' : 'border-2 border-muted-foreground/30 bg-transparent'
        }`}>
        {selected && (
          <Icon as={CheckCircle2} size={16} className="text-primary-foreground" strokeWidth={2.5} />
        )}
      </View>

      <View className="flex-1">
        <Text className="mb-1 font-roobert-semibold text-foreground">{tool.name}</Text>
        <Text
          className="font-roobert text-sm leading-relaxed text-muted-foreground"
          numberOfLines={2}
          ellipsizeMode="tail">
          {tool.description}
        </Text>
      </View>
    </Pressable>
  );
});
