import * as React from 'react';
import { View, Pressable, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import {
  ArrowLeft,
  Wrench
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import {
  useComposioProfiles,
  useComposioToolkitDetails,
  useComposioToolsBySlug,
  type ComposioApp,
  type ComposioProfile
} from '@/hooks/useComposio';
import { ToolkitIcon } from './ToolkitIcon';

interface ComposioAppDetailContentProps {
  app: ComposioApp;
  onBack?: () => void;
  noPadding?: boolean;
  onComplete?: () => void;
  onNavigateToConnector?: (app: ComposioApp) => void;
  onNavigateToTools?: (app: ComposioApp, profile: ComposioProfile) => void;
  useBottomSheetFlatList?: boolean;
}

export function ComposioAppDetailContent({
  app,
  onBack,
  noPadding = false,
  onComplete,
  onNavigateToConnector,
  onNavigateToTools,
  useBottomSheetFlatList = false
}: ComposioAppDetailContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { data: profiles, isLoading: profilesLoading } = useComposioProfiles();
  const { data: toolkitDetails, isLoading: detailsLoading } = useComposioToolkitDetails(app.slug);
  const { data: toolsResponse, isLoading: toolsLoading } = useComposioToolsBySlug(app.slug, { limit: 50 });

  const appProfiles = React.useMemo(() => {
    if (!profiles || !app) return [];

    const filteredProfiles = profiles.filter((profile: ComposioProfile) => {
      const isConnected = profile.is_connected || profile.connection_status === 'active';
      return profile.toolkit_slug === app.slug && isConnected;
    });

    return filteredProfiles;
  }, [profiles, app]);

  const availableTools = toolsResponse?.tools || [];
  const hasProfiles = appProfiles.length > 0;

  const handleMainAction = React.useCallback(() => {
    if (onNavigateToConnector) {
      onNavigateToConnector(app);
    }
  }, [hasProfiles, onNavigateToConnector, app]);

  // Render header (fixed at top)
  const renderHeader = () => (
    <View style={{ paddingHorizontal: 24, paddingTop: 24, paddingBottom: 16, backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF' }}>
      {/* Header with back button */}
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
      </View>
      <View className="mb-6">
        <View className="flex-row gap-4 mb-4">
          <View className="w-16 h-16 rounded-3xl bg-primary/5 items-center justify-center">
            <ToolkitIcon
              slug={app.slug}
              name={app.name}
              size="sm"
            />
          </View>
          <View className="flex-1">
            <Text className="text-xl font-roobert-bold text-foreground mb-1">
              {app.name}
            </Text>
            {app.description && (
              <Text
                className="text-sm font-roobert text-muted-foreground leading-relaxed mb-3"
                numberOfLines={2}
                ellipsizeMode="tail"
              >
                {app.description}
              </Text>
            )}
            <View className="flex-row items-center justify-start gap-2">
              <Pressable
                onPress={handleMainAction}
                className="self-start px-6 py-2 rounded-full bg-primary active:opacity-90"
              >
                <Text className="text-sm font-roobert-semibold text-white">
                  {hasProfiles ? t('integrations.connect').toUpperCase() : t('integrations.setup').toUpperCase()}
                </Text>
              </Pressable>
              {hasProfiles && (
                <View className="flex-row items-center justify-start gap-2">
                  <View className="w-2 h-2 rounded-full bg-green-500" />
                  <Text className="text-xs font-roobert-medium text-muted-foreground">
                    {t('integrations.appDetails.connections', { count: appProfiles.length, plural: appProfiles.length !== 1 ? 's' : '' })}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>
        <View className="flex-row items-start justify-between pt-4 border-t border-border/20">
          <View className="flex-1">
            <Text className="text-xs font-roobert text-muted-foreground uppercase tracking-wider">
              {t('integrations.appDetails.developer')}
            </Text>
            <Text className="text-lg font-roobert-semibold text-muted-foreground">
              Composio
            </Text>
          </View>
          <View className="flex-1 items-start">
            <Text className="text-xs font-roobert text-muted-foreground uppercase tracking-wider">
              {t('integrations.appDetails.tools')}
            </Text>
            <Text className="text-lg font-roobert-semibold text-muted-foreground">
              {availableTools.length > 0 ? availableTools.length : '—'}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );

  // Render tool item
  const renderToolItem = ({ item: tool, index }: { item: any; index: number }) => (
    <View
      className="flex-col items-start gap-3 p-3 bg-primary/5 rounded-2xl"
      style={{ width: '48%', marginBottom: 8 }}
    >
      <View className="w-8 h-8 bg-primary rounded-full items-center justify-center">
        <Icon as={Wrench} size={16} className="text-primary-foreground" />
      </View>
      <View className="flex-1">
        <Text className="text-sm font-roobert-medium text-foreground">
          {tool.name || `Tool ${index + 1}`}
        </Text>
        {tool.description && (
          <Text
            className="text-xs font-roobert text-muted-foreground mt-0.5"
            numberOfLines={2}
            ellipsizeMode="tail"
          >
            {tool.description}
          </Text>
        )}
        {!tool.description && tool.tags && tool.tags.length > 0 && (
          <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
            {tool.tags[0]}
          </Text>
        )}
        {!tool.description && (!tool.tags || tool.tags.length === 0) && (
          <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
            Automation tool for {app.name}
          </Text>
        )}
      </View>
    </View>
  );

  // When using BottomSheetFlatList, render with fixed header
  if (useBottomSheetFlatList) {
    if (detailsLoading) {
      return (
        <View style={{ flex: 1 }}>
          {renderHeader()}
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
            <Text className="text-sm font-roobert text-muted-foreground mt-2">
              {t('integrations.loadingIntegrations')}
            </Text>
          </View>
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        {/* Fixed header */}
        {renderHeader()}

        {/* Scrollable tools list */}
        {availableTools.length > 0 ? (
          <BottomSheetFlatList
            data={availableTools.slice(0, 12)}
            keyExtractor={(item: any, index: number) => item.slug || item.name || `tool-${index}`}
            renderItem={renderToolItem}
            numColumns={2}
            columnWrapperStyle={{ paddingHorizontal: 24, justifyContent: 'space-between' }}
            contentContainerStyle={{ paddingBottom: 32 }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={{ paddingHorizontal: 24, paddingVertical: 32 }}>
                <View className="p-6 bg-muted/5 border border-border/30 rounded-xl">
                  <Text className="text-sm font-roobert text-muted-foreground text-center">
                    {t('integrations.appDetails.noToolsFound')}
                  </Text>
                </View>
              </View>
            }
            ListFooterComponent={
              availableTools.length > 12 ? (
                <View style={{ paddingHorizontal: 24, paddingTop: 8 }}>
                  <View className="p-3 bg-muted/5 border border-border/30 rounded-xl">
                    <Text className="text-sm font-roobert text-muted-foreground text-center">
                      {t('integrations.appDetails.toolsAvailableAfterSetup', { count: availableTools.length - 12 })}
                    </Text>
                  </View>
                </View>
              ) : null
            }
          />
        ) : !toolsLoading ? (
          <View style={{ paddingHorizontal: 24, paddingTop: 16 }}>
            <View className="p-6 bg-muted/5 border border-border/30 rounded-xl">
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                {t('integrations.appDetails.noToolsFound')}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    );
  }

  // Regular scrollable view (for non-BottomSheet usage)
  return (
    <View className={noPadding ? "pb-6" : "pb-6"}>
      {/* Header with back button */}
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
      </View>
      <View className="mb-6">
        <View className="flex-row gap-4 mb-4">
          <View className="w-16 h-16 rounded-3xl bg-primary/5 items-center justify-center">
            <ToolkitIcon
              slug={app.slug}
              name={app.name}
              size="sm"
            />
          </View>
          <View className="flex-1">
            <Text className="text-xl font-roobert-bold text-foreground mb-1">
              {app.name}
            </Text>
            {app.description && (
              <Text
                className="text-sm font-roobert text-muted-foreground leading-relaxed mb-3"
                numberOfLines={2}
                ellipsizeMode="tail"
              >
                {app.description}
              </Text>
            )}
            <View className="flex-row items-center justify-start gap-2">
              <Pressable
                onPress={handleMainAction}
                className="self-start px-6 py-2 rounded-full bg-primary active:opacity-90"
              >
                <Text className="text-sm font-roobert-semibold text-white">
                  {hasProfiles ? t('integrations.connect').toUpperCase() : t('integrations.setup').toUpperCase()}
                </Text>
              </Pressable>
              {hasProfiles && (
                <View className="flex-row items-center justify-start gap-2">
                  <View className="w-2 h-2 rounded-full bg-green-500" />
                  <Text className="text-xs font-roobert-medium text-muted-foreground">
                    {t('integrations.appDetails.connections', { count: appProfiles.length, plural: appProfiles.length !== 1 ? 's' : '' })}
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>
        <View className="flex-row items-start justify-between pt-4 border-t border-border/20">
          <View className="flex-1">
            <Text className="text-xs font-roobert text-muted-foreground uppercase tracking-wider">
              {t('integrations.appDetails.developer')}
            </Text>
            <Text className="text-lg font-roobert-semibold text-muted-foreground">
              Composio
            </Text>
          </View>
          <View className="flex-1 items-start">
            <Text className="text-xs font-roobert text-muted-foreground uppercase tracking-wider">
              {t('integrations.appDetails.tools')}
            </Text>
            <Text className="text-lg font-roobert-semibold text-muted-foreground">
              {availableTools.length > 0 ? availableTools.length : '—'}
            </Text>
          </View>
        </View>
      </View>
      {detailsLoading ? (
        <View className="items-center py-8">
          <ActivityIndicator size="large" className="text-primary" />
          <Text className="text-sm font-roobert text-muted-foreground mt-2">
            {t('integrations.loadingIntegrations')}
          </Text>
        </View>
      ) : (
        <>
          {availableTools.length > 0 && (
            <View className="mb-8">
              <View className="flex-row flex-wrap gap-2">
                {availableTools.slice(0, 12).map((tool: any, index: number) => (
                  <View
                    key={tool.slug || tool.name || index}
                    className="flex-col items-start gap-3 p-3 bg-primary/5 rounded-2xl"
                    style={{ width: '48%' }}
                  >
                    <View className="w-8 h-8 bg-primary rounded-full items-center justify-center">
                      <Icon as={Wrench} size={16} className="text-primary-foreground" />
                    </View>
                    <View className="flex-1">
                      <Text className="text-sm font-roobert-medium text-foreground">
                        {tool.name || `Tool ${index + 1}`}
                      </Text>
                      {tool.description && (
                        <Text
                          className="text-xs font-roobert text-muted-foreground mt-0.5"
                          numberOfLines={2}
                          ellipsizeMode="tail"
                        >
                          {tool.description}
                        </Text>
                      )}
                      {!tool.description && tool.tags && tool.tags.length > 0 && (
                        <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
                          {tool.tags[0]}
                        </Text>
                      )}
                      {!tool.description && (!tool.tags || tool.tags.length === 0) && (
                        <Text className="text-xs font-roobert text-muted-foreground mt-0.5">
                          Automation tool for {app.name}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
                {availableTools.length > 12 && (
                  <View className="p-3 bg-muted/5 border border-border/30 rounded-xl" style={{ width: '48%' }}>
                    <Text className="text-sm font-roobert text-muted-foreground text-center">
                      {t('integrations.appDetails.toolsAvailableAfterSetup', { count: availableTools.length - 12 })}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}
          {availableTools.length === 0 && !toolsLoading && (
            <View className="mb-8 p-6 bg-muted/5 border border-border/30 rounded-xl">
              <Text className="text-sm font-roobert text-muted-foreground text-center">
                {t('integrations.appDetails.noToolsFound')}
              </Text>
            </View>
          )}
        </>
      )}
      <View className="h-6" />
    </View>
  );
}
