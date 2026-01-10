import * as React from 'react';
import { View, Pressable, ActivityIndicator, FlatList, TextInput } from 'react-native';
import { BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ArrowLeft, Search, CheckCircle2, X } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useLanguage } from '@/contexts';
import {
  useComposioApps,
  useComposioProfiles,
  type ComposioApp,
  type ComposioProfile,
} from '@/hooks/useComposio';
import { useAgent } from '@/lib/agents/hooks';
import * as Haptics from 'expo-haptics';
import { ToolkitIcon } from './ToolkitIcon';
import { useBillingContext } from '@/contexts/BillingContext';
import { FreeTierBlock } from '@/components/billing/FreeTierBlock';
import { useRouter } from 'expo-router';
import { EmptyState } from '@/components/shared/EmptyState';
import { log } from '@/lib/logger';

interface ComposioAppsContentProps {
  onBack?: () => void;
  onAppSelect?: (app: ComposioApp) => void;
  noPadding?: boolean;
  agentId?: string;
  useBottomSheetFlatList?: boolean;
  isBlocked?: boolean;
  onBlockedClick?: () => void;
}

export function ComposioAppsContent({
  onBack,
  onAppSelect,
  noPadding = false,
  agentId,
  useBottomSheetFlatList = false,
  isBlocked,
  onBlockedClick,
}: ComposioAppsContentProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const router = useRouter();
  const { data: appsData, isLoading, error, refetch } = useComposioApps();
  const { data: agent } = useAgent(agentId || '');
  const { data: profiles } = useComposioProfiles();
  const [searchQuery, setSearchQuery] = React.useState('');
  const { hasFreeTier } = useBillingContext();

  // Check if integrations are blocked for free tier users
  const shouldBlock = isBlocked !== undefined ? isBlocked : hasFreeTier;

  // Handle upgrade press - use provided callback or navigate to plans
  const handleUpgradePress = React.useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (onBlockedClick) {
      onBlockedClick();
    } else {
      router.push('/plans');
    }
  }, [onBlockedClick, router]);

  const apps = appsData?.toolkits || [];

  // Check if an app is connected to the agent
  const isAppConnectedToAgent = React.useCallback(
    (appSlug: string): boolean => {
      if (!agent?.custom_mcps || !profiles) return false;

      return agent.custom_mcps.some((mcpConfig: any) => {
        if (mcpConfig.type === 'composio' && mcpConfig.config?.profile_id) {
          const profile = profiles.find(
            (p: ComposioProfile) => p.profile_id === mcpConfig.config.profile_id
          );
          return profile?.toolkit_slug === appSlug;
        }
        return false;
      });
    },
    [agent, profiles]
  );

  const filteredApps = React.useMemo(() => {
    if (!searchQuery.trim()) return apps;

    const query = searchQuery.toLowerCase();
    return apps.filter(
      (app: ComposioApp) =>
        app.name.toLowerCase().includes(query) ||
        app.description?.toLowerCase().includes(query) ||
        app.categories?.some((cat) => cat.toLowerCase().includes(query))
    );
  }, [apps, searchQuery]);

  const handleAppPress = React.useCallback(
    (app: ComposioApp) => {
      // Block free tier users
      if (shouldBlock) {
        handleUpgradePress();
        return;
      }

      // Don't allow selecting already connected apps
      if (agentId && isAppConnectedToAgent(app.slug)) {
        return;
      }

      log.log('🎯 App selected:', app.name);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (onAppSelect) {
        onAppSelect(app);
      }
    },
    [onAppSelect, agentId, isAppConnectedToAgent, shouldBlock, handleUpgradePress]
  );

  // Header component for FlatList
  const renderHeader = () => (
    <>
      {/* Search Bar */}
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
            placeholder={t('composio.searchApps')}
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
    </>
  );

  // Loading component
  const renderLoading = () => (
    <View className="items-center justify-center py-12">
      <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
      <Text className="mt-4 font-roobert text-sm text-muted-foreground">
        {t('integrations.loadingIntegrations')}
      </Text>
    </View>
  );

  // Error component
  const renderError = () => (
    <View className="items-center py-8">
      <Text className="mb-2 font-roobert-medium text-lg text-foreground">
        {t('integrations.failedToLoad')}
      </Text>
      <Text className="mb-4 font-roobert text-sm text-muted-foreground">
        {error?.message || 'An error occurred'}
      </Text>
      <Pressable onPress={() => refetch()} className="rounded-xl bg-primary px-6 py-3">
        <Text className="font-roobert-medium text-white">{t('integrations.retry')}</Text>
      </Pressable>
    </View>
  );

  // When using BottomSheetFlatList, render it directly without wrapper
  if (useBottomSheetFlatList) {
    // Show full card block for free tier users
    if (shouldBlock) {
      return (
        <View style={{ flex: 1, paddingHorizontal: 24, paddingTop: 24 }}>
          {/* Header with back button */}
          <View className="mb-6 flex-row items-center">
            {onBack && (
              <Pressable onPress={onBack} className="flex-row items-center active:opacity-70">
                <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </Pressable>
            )}
            <View className="ml-3 flex-1">
              <Text
                style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
                className="font-roobert-semibold text-xl">
                {t('integrations.composioApps')}
              </Text>
            </View>
          </View>

          <FreeTierBlock variant="integrations" onUpgradePress={handleUpgradePress} style="card" />
        </View>
      );
    }

    if (isLoading) {
      return (
        <View style={{ flex: 1 }}>
          <View style={{ paddingHorizontal: 24, paddingTop: 24 }}>{renderHeader()}</View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {renderLoading()}
          </View>
        </View>
      );
    }

    if (error) {
      return (
        <View style={{ flex: 1 }}>
          <View style={{ paddingHorizontal: 24, paddingTop: 24 }}>{renderHeader()}</View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            {renderError()}
          </View>
        </View>
      );
    }

    return (
      <View style={{ flex: 1 }}>
        {/* Sticky header and search bar */}
        <View
          style={{
            paddingHorizontal: 24,
            paddingTop: 24,
            paddingBottom: 16,
            backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
          }}>
          {renderHeader()}
        </View>

        {/* Scrollable apps list */}
        <BottomSheetFlatList
          data={filteredApps}
          keyExtractor={(item: ComposioApp) => item.slug}
          renderItem={({ item: app }: { item: ComposioApp }) => {
            const isConnected = agentId ? isAppConnectedToAgent(app.slug) : false;
            return (
              <View style={{ paddingHorizontal: 24 }}>
                <AppCard
                  app={app}
                  onPress={() => handleAppPress(app)}
                  isConnected={isConnected}
                  disabled={isConnected}
                />
              </View>
            );
          }}
          contentContainerStyle={{ paddingBottom: 32 }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          initialNumToRender={20}
          windowSize={10}
          ListEmptyComponent={
            <View className="px-6 py-8">
              <EmptyState
                icon={Search}
                title={searchQuery ? t('integrations.noAppsFound') : t('integrations.noAppsAvailable')}
                description={
                  searchQuery
                    ? t('integrations.tryDifferentSearch')
                    : t('integrations.appsAppearHere')
                }
              />
            </View>
          }
        />
      </View>
    );
  }

  // Regular FlatList for non-BottomSheet usage
  // Show full card block for free tier users
  if (shouldBlock) {
    return (
      <View className="flex-1 py-4" style={{ flex: 1 }}>
        {/* Header with back button */}
        <View className="mb-6 flex-row items-center">
          {onBack && (
            <Pressable onPress={onBack} className="flex-row items-center active:opacity-70">
              <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
            </Pressable>
          )}
          <View className="ml-3 flex-1">
            <Text
              style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
              className="font-roobert-semibold text-xl">
              {t('integrations.composioApps')}
            </Text>
          </View>
        </View>

        <FreeTierBlock variant="integrations" onUpgradePress={handleUpgradePress} style="card" />
      </View>
    );
  }

  return (
    <View className="flex-1" style={{ flex: 1 }}>
      {isLoading ? (
        <View className="flex-1">
          {renderHeader()}
          {renderLoading()}
        </View>
      ) : error ? (
        <View className="flex-1">
          {renderHeader()}
          {renderError()}
        </View>
      ) : (
        <FlatList
          data={filteredApps}
          keyExtractor={(item) => item.slug}
          renderItem={({ item: app }) => {
            const isConnected = agentId ? isAppConnectedToAgent(app.slug) : false;
            return (
              <AppCard
                app={app}
                onPress={() => handleAppPress(app)}
                isConnected={isConnected}
                disabled={isConnected}
              />
            );
          }}
          ListHeaderComponent={() => renderHeader()}
          contentContainerStyle={{ paddingBottom: 16 }}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          updateCellsBatchingPeriod={50}
          initialNumToRender={20}
          windowSize={10}
          ListEmptyComponent={
            <View className="px-6 py-8">
              <EmptyState
                icon={Search}
                title={searchQuery ? t('integrations.noAppsFound') : t('integrations.noAppsAvailable')}
                description={
                  searchQuery
                    ? t('integrations.tryDifferentSearch')
                    : t('integrations.appsAppearHere')
                }
              />
            </View>
          }
        />
      )}
    </View>
  );
}

interface AppCardProps {
  app: ComposioApp;
  onPress: () => void;
  isConnected?: boolean;
  disabled?: boolean;
}

const AppCard = React.memo(
  ({ app, onPress, isConnected = false, disabled = false }: AppCardProps) => {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        className={`mb-3 flex-row items-center gap-4 rounded-3xl p-4 ${
          disabled ? 'bg-muted/5 opacity-50' : 'bg-primary/5 active:opacity-80'
        }`}>
        <ToolkitIcon slug={app.slug} name={app.name} size="sm" />
        <View className="flex-1">
          <Text
            className={`font-roobert-semibold text-base ${
              disabled ? 'text-muted-foreground' : 'text-foreground'
            }`}>
            {app.name}
          </Text>
          <Text
            className="font-roobert text-sm text-muted-foreground"
            numberOfLines={2}
            ellipsizeMode="tail">
            {app.description}
          </Text>
          {isConnected && (
            <Text className="mt-1 font-roobert-medium text-xs text-blue-600 dark:text-blue-400">
              Connected
            </Text>
          )}
        </View>

        {(app.connected || isConnected) && (
          <View className="h-6 w-6 items-center justify-center rounded-full bg-green-500">
            <Icon as={CheckCircle2} size={16} className="text-white" />
          </View>
        )}
      </Pressable>
    );
  }
);
