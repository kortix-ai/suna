/**
 * App Selection Step Component
 *
 * Displays apps with connection status indicators
 * Matches frontend design adapted for mobile
 * Returns content only - no ScrollView (parent handles scrolling)
 */

import React from 'react';
import { View, Image } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { ChevronRight } from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { Loading } from '../loading/loading';
import { SearchBar } from '@/components/ui/SearchBar';
import { Pressable } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { TriggerApp } from '@/api/types';
import type { ComposioProfile } from '@/hooks/useComposio';
import { SvgUri } from 'react-native-svg';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface AppSelectionStepProps {
  apps: TriggerApp[];
  isLoading: boolean;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onAppSelect: (app: TriggerApp) => void;
  profiles?: ComposioProfile[];
}

interface AppCardProps {
  app: TriggerApp;
  connectionStatus: { isConnected: boolean; hasProfiles: boolean };
  onPress: () => void;
}

function AppCard({ app, connectionStatus, onPress }: AppCardProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.98, { damping: 15, stiffness: 400 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1);
  };

  const isSvg = (url: string) =>
    url.toLowerCase().endsWith('.svg') || url.includes('composio.dev/api');

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="mb-3 rounded-2xl border border-border bg-card p-4 active:opacity-80">
      <View className="flex-row items-start gap-3">
        {/* App Logo */}
        {app.logo ? (
          <View className="h-10 w-10 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
            {isSvg(app.logo) ? (
              <SvgUri uri={app.logo} width={24} height={24} />
            ) : (
              <Image
                source={{ uri: app.logo }}
                style={{ width: 24, height: 24 }}
                resizeMode="contain"
              />
            )}
          </View>
        ) : (
          <View className="h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
            <Text className="font-roobert-semibold text-base text-muted-foreground">
              {app.name.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}

        {/* Content */}
        <View className="min-w-0 flex-1">
          <Text className="mb-1 font-roobert-medium text-base text-foreground" numberOfLines={1}>
            {app.name}
          </Text>
          <Text className="mb-3 text-xs text-muted-foreground" numberOfLines={2}>
            {connectionStatus.isConnected
              ? `Create automated triggers from ${app.name} events`
              : connectionStatus.hasProfiles
                ? `Connect your ${app.name} account to create triggers`
                : `Set up ${app.name} connection to get started`}
          </Text>

          {/* Status Badge */}
          <View className="flex-row items-center gap-1.5 border-t border-border pt-2">
            {connectionStatus.isConnected ? (
              <>
                <View className="h-1.5 w-1.5 rounded-full bg-green-500" />
                <Text className="font-roobert-medium text-xs text-green-600 dark:text-green-400">
                  Connected
                </Text>
              </>
            ) : connectionStatus.hasProfiles ? (
              <>
                <View className="h-1.5 w-1.5 rounded-full bg-yellow-500" />
                <Text className="font-roobert-medium text-xs text-yellow-600 dark:text-yellow-400">
                  Not Connected
                </Text>
              </>
            ) : (
              <>
                <View className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                <Text className="font-roobert-medium text-xs text-muted-foreground">
                  Setup Required
                </Text>
              </>
            )}
          </View>
        </View>

        {/* Chevron */}
        <Icon as={ChevronRight} size={18} className="mt-1 flex-shrink-0 text-muted-foreground" />
      </View>
    </AnimatedPressable>
  );
}

export function AppSelectionStep({
  apps,
  isLoading,
  searchQuery,
  onSearchChange,
  onAppSelect,
  profiles = [],
}: AppSelectionStepProps) {
  // Helper to check connection status for an app
  const getAppConnectionStatus = (appSlug: string) => {
    const appProfiles = profiles.filter((p: ComposioProfile) => p.toolkit_slug === appSlug);
    const connectedProfiles = appProfiles.filter((p: ComposioProfile) => p.is_connected);
    return {
      isConnected: connectedProfiles.length > 0,
      hasProfiles: appProfiles.length > 0,
    };
  };

  // Filter apps by search query
  const filteredApps = apps.filter(
    (app) =>
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.slug.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (isLoading) {
    return <Loading title="Loading apps..." />;
  }

  return (
    <View className="space-y-6">
      {/* Search Bar */}
      <View>
        <SearchBar
          value={searchQuery}
          onChangeText={onSearchChange}
          placeholder="Search apps..."
          onClear={() => onSearchChange('')}
        />
      </View>

      {/* Apps List */}
      {filteredApps.length === 0 ? (
        <View className="items-center justify-center py-16">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={ChevronRight} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">
            No apps found
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            {searchQuery ? `No apps match "${searchQuery}"` : 'No apps with triggers available'}
          </Text>
        </View>
      ) : (
        <View>
          {filteredApps.map((app) => (
            <AppCard
              key={app.slug}
              app={app}
              connectionStatus={getAppConnectionStatus(app.slug)}
              onPress={() => onAppSelect(app)}
            />
          ))}
        </View>
      )}
    </View>
  );
}
