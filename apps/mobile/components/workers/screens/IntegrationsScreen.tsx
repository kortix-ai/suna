/**
 * Integrations Screen Component
 *
 * Allows configuring Composio app integrations for a worker
 * Shows connected apps and allows adding new ones
 */

import React, { useState, useMemo } from 'react';
import { View, Pressable, ActivityIndicator, Image, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useAgent, useUpdateAgent } from '@/lib/agents/hooks';
import { useComposioApps, useComposioProfiles, type ComposioApp, type ComposioProfile } from '@/hooks/useComposio';
import { Plus, ChevronRight, CheckCircle2, Settings, X } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { SearchBar } from '@/components/ui/SearchBar';
import { ComposioConnectorContent } from '@/components/settings/integrations/ComposioConnector';
import { ComposioToolsContent } from '@/components/settings/integrations/ComposioToolsSelector';
import { SvgUri } from 'react-native-svg';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface IntegrationsScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

interface AppCardProps {
  app: ComposioApp;
  connectionStatus: { isConnected: boolean; hasProfiles: boolean; profiles: ComposioProfile[]; enabledToolsCount: number };
  onPress: () => void;
  onManageTools?: (app: ComposioApp, profile: ComposioProfile) => void;
}

function AppCard({ app, connectionStatus, onPress, onManageTools }: AppCardProps) {
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
              ? connectionStatus.enabledToolsCount > 0
                ? `${connectionStatus.enabledToolsCount} tool${connectionStatus.enabledToolsCount !== 1 ? 's' : ''} enabled`
                : 'Connected (no tools)'
              : connectionStatus.hasProfiles
                ? `Connect your ${app.name} account`
                : `Set up ${app.name} connection`}
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

        {/* Actions */}
        <View className="flex-row items-center gap-2">
          {connectionStatus.isConnected && onManageTools && connectionStatus.profiles.length > 0 && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation();
                onManageTools?.(app, connectionStatus.profiles[0]);
              }}
              className="h-8 w-8 items-center justify-center rounded-lg bg-muted active:opacity-80">
              <Icon as={Settings} size={16} className="text-foreground" />
            </Pressable>
          )}
          <Icon as={ChevronRight} size={18} className="flex-shrink-0 text-muted-foreground" />
        </View>
      </View>
    </AnimatedPressable>
  );
}

export function IntegrationsScreen({ agentId, onUpdate }: IntegrationsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { data: agent, isLoading: isLoadingAgent } = useAgent(agentId);
  const { data: appsData, isLoading: isLoadingApps } = useComposioApps();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();
  const updateAgentMutation = useUpdateAgent();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedApp, setSelectedApp] = useState<ComposioApp | null>(null);
  const [showConnector, setShowConnector] = useState(false);
  const [showToolsManager, setShowToolsManager] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<ComposioProfile | null>(null);

  const apps = appsData?.toolkits || [];

  // Get connection status and enabled tools count for each app
  const getAppConnectionStatus = (appSlug: string) => {
    const appProfiles = (profiles || []).filter((p: ComposioProfile) => p.toolkit_slug === appSlug);
    const connectedProfiles = appProfiles.filter((p: ComposioProfile) => p.is_connected);

    // Get enabled tools count from agent's custom_mcps
    let enabledToolsCount = 0;
    if (agent?.custom_mcps && connectedProfiles.length > 0) {
      connectedProfiles.forEach((profile: ComposioProfile) => {
        const composioMcp = agent.custom_mcps.find(
          (mcp: any) => mcp.type === 'composio' && mcp.config?.profile_id === profile.profile_id
        );
        if (composioMcp?.enabledTools) {
          enabledToolsCount += composioMcp.enabledTools.length;
        }
      });
    }

    return {
      isConnected: connectedProfiles.length > 0,
      hasProfiles: appProfiles.length > 0,
      profiles: connectedProfiles,
      enabledToolsCount,
    };
  };

  // Filter apps by search query
  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) return apps;

    const query = searchQuery.toLowerCase();
    return apps.filter((app: ComposioApp) =>
      app.name.toLowerCase().includes(query) ||
      app.slug.toLowerCase().includes(query) ||
      app.description?.toLowerCase().includes(query)
    );
  }, [apps, searchQuery]);

  const handleAppSelect = (app: ComposioApp) => {
    const connectionStatus = getAppConnectionStatus(app.slug);
    if (connectionStatus.isConnected) {
      // Show options: manage tools or reconnect
      Alert.alert(
        app.name,
        'This app is already connected. What would you like to do?',
        [
          {
            text: 'Manage Tools',
            onPress: () => {
              if (connectionStatus.profiles.length > 0) {
                setSelectedApp(app);
                setSelectedProfile(connectionStatus.profiles[0]);
                setShowToolsManager(true);
              }
            },
          },
          {
            text: 'Reconnect',
            onPress: () => {
              setSelectedApp(app);
              setShowConnector(true);
            },
          },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
    } else {
      setSelectedApp(app);
      setShowConnector(true);
    }
  };

  const handleConnectorComplete = (profileId: string, appName: string, appSlug: string) => {
    // Add the Composio MCP to the agent
    const customMcps = agent?.custom_mcps || [];
    const existingMcp = customMcps.find(
      (mcp: any) => mcp.type === 'composio' && mcp.config?.profile_id === profileId
    );

      if (!existingMcp) {
      const newMcp = {
        name: appName,
        type: 'composio' as any, // Backend accepts 'composio' type
        config: {
          profile_id: profileId,
          toolkit_slug: appSlug,
        },
        enabledTools: [],
      };

      updateAgentMutation.mutate(
        {
          agentId,
          data: {
            custom_mcps: [...customMcps, newMcp],
          },
        },
        {
          onSuccess: () => {
            setShowConnector(false);
            setSelectedApp(null);
            onUpdate?.();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
          onError: (error: any) => {
            Alert.alert('Error', error?.message || 'Failed to add integration');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          },
        }
      );
    } else {
      setShowConnector(false);
      setSelectedApp(null);
    }
  };

  const handleManageTools = (app: ComposioApp, profile: ComposioProfile) => {
    setSelectedApp(app);
    setSelectedProfile(profile);
    setShowToolsManager(true);
  };

  if (isLoadingAgent || isLoadingApps) {
    return (
      <View className="items-center justify-center py-12">
        <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        <Text className="mt-4 font-roobert text-sm text-muted-foreground">
          Loading integrations...
        </Text>
      </View>
    );
  }

  if (showConnector && selectedApp) {
    return (
      <View>
        <View className="mb-4 flex-row items-center justify-between">
          <Pressable
            onPress={() => {
              setShowConnector(false);
              setSelectedApp(null);
            }}
            className="h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
            <Icon as={X} size={20} className="text-foreground" />
          </Pressable>
          <Text className="flex-1 text-center font-roobert-semibold text-lg text-foreground">
            Connect {selectedApp.name}
          </Text>
          <View className="w-10" />
        </View>
        <ComposioConnectorContent
          app={selectedApp}
          onBack={() => {
            setShowConnector(false);
            setSelectedApp(null);
          }}
          onComplete={handleConnectorComplete}
          agentId={agentId}
          mode="full"
        />
      </View>
    );
  }

  if (showToolsManager && selectedApp && selectedProfile) {
    return (
      <View className="flex-1">
        <View className="mb-4 flex-row items-center justify-between">
          <Pressable
            onPress={() => {
              setShowToolsManager(false);
              setSelectedApp(null);
              setSelectedProfile(null);
            }}
            className="h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
            <Icon as={X} size={20} className="text-foreground" />
          </Pressable>
          <Text className="flex-1 text-center font-roobert-semibold text-lg text-foreground">
            {selectedApp.name} Tools
          </Text>
          <View className="w-10" />
        </View>
        <ComposioToolsContent
          app={selectedApp}
          profile={selectedProfile}
          agentId={agentId}
          onBack={() => {
            setShowToolsManager(false);
            setSelectedApp(null);
            setSelectedProfile(null);
          }}
          onComplete={() => {
            setShowToolsManager(false);
            setSelectedApp(null);
            setSelectedProfile(null);
            onUpdate?.();
          }}
          noPadding={true}
        />
      </View>
    );
  }

  return (
    <View className="space-y-4">
      <View>
        <Text className="mb-2 font-roobert-semibold text-base text-foreground">
          Integrations
        </Text>
        <Text className="mb-4 font-roobert text-sm text-muted-foreground">
          Connect apps and services to give your worker more capabilities
        </Text>
      </View>

      {/* Search Bar */}
      <View>
        <SearchBar
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search apps..."
          onClear={() => setSearchQuery('')}
        />
      </View>

      {/* Apps List */}
      {filteredApps.length === 0 ? (
        <View className="items-center justify-center py-16">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={Plus} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">
            No apps found
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            {searchQuery ? `No apps match "${searchQuery}"` : 'No apps available'}
          </Text>
        </View>
      ) : (
        <View>
          {filteredApps.map((app: ComposioApp) => (
            <AppCard
              key={app.slug}
              app={app}
              connectionStatus={getAppConnectionStatus(app.slug)}
              onPress={() => handleAppSelect(app)}
              onManageTools={handleManageTools}
            />
          ))}
        </View>
      )}
    </View>
  );
}

