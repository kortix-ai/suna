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
import {
  useComposioApps,
  useComposioProfiles,
  type ComposioApp,
  type ComposioProfile,
} from '@/hooks/useComposio';
import { Plus, CheckCircle2, Settings, X, Store, Trash2 } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ComposioConnectorContent } from '@/components/settings/integrations/ComposioConnector';
import { ComposioToolsContent } from '@/components/settings/integrations/ComposioToolsSelector';
import { ComposioAppsContent } from '@/components/settings/integrations/ComposioAppsList';
import { SvgUri } from 'react-native-svg';

interface IntegrationsScreenProps {
  agentId: string;
  onUpdate?: () => void;
}

interface ActiveIntegrationCardProps {
  mcp: any;
  profile: ComposioProfile | null;
  app: ComposioApp | null;
  onManageTools: () => void;
  onDelete: () => void;
}

function ActiveIntegrationCard({
  mcp,
  profile,
  app,
  onManageTools,
  onDelete,
}: ActiveIntegrationCardProps) {
  const enabledToolsCount = Array.isArray(mcp.enabledTools) ? mcp.enabledTools.length : 0;
  const isSvg = (url: string) =>
    url.toLowerCase().endsWith('.svg') || url.includes('composio.dev/api');

  return (
    <View className="mb-3 rounded-2xl border border-border bg-card p-4">
      <View className="flex-row items-center gap-3">
        {/* App Logo */}
        {app?.logo ? (
          <View className="h-12 w-12 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
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
          <View className="h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-border bg-muted">
            <Text className="font-roobert-semibold text-base text-muted-foreground">
              {mcp.name?.charAt(0).toUpperCase() || 'A'}
            </Text>
          </View>
        )}

        {/* Content */}
        <View className="min-w-0 flex-1">
          <Text className="mb-1 font-roobert-medium text-base text-foreground" numberOfLines={1}>
            {mcp.name}
          </Text>
          <Text className="mb-1 text-xs text-muted-foreground">
            {enabledToolsCount} tool{enabledToolsCount !== 1 ? 's' : ''} enabled
          </Text>
          {profile && (
            <View className="flex-row items-center gap-1">
              <Icon as={CheckCircle2} size={12} className="text-green-600 dark:text-green-400" />
              <Text
                className="text-xs font-medium text-green-600 dark:text-green-400"
                numberOfLines={1}>
                {profile.profile_name}
              </Text>
            </View>
          )}
        </View>

        {/* Actions */}
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={onManageTools}
            className="h-10 w-10 items-center justify-center rounded-lg bg-muted active:opacity-80">
            <Icon as={Settings} size={18} className="text-foreground" />
          </Pressable>
          <Pressable
            onPress={onDelete}
            className="h-10 w-10 items-center justify-center rounded-lg bg-muted active:opacity-80">
            <Icon as={Trash2} size={18} className="text-destructive" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function IntegrationsScreen({ agentId, onUpdate }: IntegrationsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { data: agent, isLoading: isLoadingAgent } = useAgent(agentId);
  const { data: appsData, isLoading: isLoadingApps } = useComposioApps();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();
  const updateAgentMutation = useUpdateAgent();

  const [selectedApp, setSelectedApp] = useState<ComposioApp | null>(null);
  const [showConnector, setShowConnector] = useState(false);
  const [showToolsManager, setShowToolsManager] = useState(false);
  const [showBrowseApps, setShowBrowseApps] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<ComposioProfile | null>(null);

  const apps = appsData?.toolkits || [];

  // Get active integrations from custom_mcps
  const activeIntegrations = useMemo(() => {
    if (!agent?.custom_mcps || !Array.isArray(agent.custom_mcps)) return [];

    return agent.custom_mcps
      .filter(
        (mcp: any) =>
          mcp.type === 'composio' && Array.isArray(mcp.enabledTools) && mcp.enabledTools.length > 0
      )
      .map((mcp: any) => {
        const profileId = mcp.config?.profile_id;
        const profile = profiles?.find((p: ComposioProfile) => p.profile_id === profileId);
        const toolkitSlug = mcp.toolkit_slug || mcp.config?.toolkit_slug;
        const app = apps.find((a: ComposioApp) => a.slug === toolkitSlug);

        return {
          mcp,
          profile: profile || null,
          app: app || null,
        };
      });
  }, [agent?.custom_mcps, profiles, apps]);

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

  const handleManageTools = (app: ComposioApp | null, profile: ComposioProfile) => {
    // If app is not found, create a fallback app object from MCP and profile data
    const finalApp: ComposioApp = app || {
      name: profile.toolkit_name || 'Unknown',
      slug: profile.toolkit_slug || '',
      logo: '',
      description: '',
      categories: [],
      connected: profile.is_connected,
    };
    setSelectedApp(finalApp);
    setSelectedProfile(profile);
    setShowToolsManager(true);
  };

  const handleDeleteIntegration = (mcp: any) => {
    Alert.alert(
      'Remove Integration',
      `Are you sure you want to remove the "${mcp.name}" integration? This will disconnect all associated tools and cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Integration',
          style: 'destructive',
          onPress: () => {
            const customMcps = agent?.custom_mcps || [];
            const updatedMcps = customMcps.filter(
              (existingMcp: any) =>
                !(
                  existingMcp.type === 'composio' &&
                  existingMcp.config?.profile_id === mcp.config?.profile_id
                )
            );

            updateAgentMutation.mutate(
              {
                agentId,
                data: {
                  custom_mcps: updatedMcps,
                },
              },
              {
                onSuccess: () => {
                  onUpdate?.();
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                },
                onError: (error: any) => {
                  Alert.alert('Error', error?.message || 'Failed to remove integration');
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
                },
              }
            );
          },
        },
      ]
    );
  };

  const handleBrowseAppSelect = (app: ComposioApp) => {
    setShowBrowseApps(false);
    setSelectedApp(app);
    setShowConnector(true);
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

  if (showBrowseApps) {
    return (
      <View className="flex-1">
        <View className="mb-4 flex-row items-center justify-between">
          <Pressable
            onPress={() => setShowBrowseApps(false)}
            className="h-10 w-10 items-center justify-center rounded-xl active:opacity-80">
            <Icon as={X} size={20} className="text-foreground" />
          </Pressable>
          <Text className="flex-1 text-center font-roobert-semibold text-lg text-foreground">
            Browse Apps
          </Text>
          <View className="w-10" />
        </View>
        <ComposioAppsContent
          onBack={() => setShowBrowseApps(false)}
          onAppSelect={handleBrowseAppSelect}
          noPadding={true}
        />
      </View>
    );
  }

  if (showToolsManager && selectedApp && selectedProfile) {
    return (
      <View className="flex-1">
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
      {/* Browse Apps Button */}
      <View className="mb-4">
        <Pressable
          onPress={() => setShowBrowseApps(true)}
          className="flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-80">
          <Icon as={Store} size={18} className="text-foreground" />
          <Text className="font-roobert-semibold text-base text-foreground">Browse Apps</Text>
        </Pressable>
      </View>

      {/* Active Integrations List */}
      {activeIntegrations.length === 0 ? (
        <View className="items-center justify-center py-12">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={Plus} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">
            No integrations configured
          </Text>
          <Text className="text-center text-sm text-muted-foreground">
            Browse the app registry to connect your apps or add custom MCP servers
          </Text>
        </View>
      ) : (
        <View>
          {activeIntegrations.map((integration, index) => {
            const profile = integration.profile;
            const app = integration.app;

            // Find profile if we have app but no profile
            let finalProfile = profile;
            if (!finalProfile && app && integration.mcp.config?.profile_id) {
              finalProfile =
                profiles?.find(
                  (p: ComposioProfile) => p.profile_id === integration.mcp.config.profile_id
                ) || null;
            }

            return (
              <ActiveIntegrationCard
                key={`${integration.mcp.config?.profile_id || index}`}
                mcp={integration.mcp}
                profile={finalProfile}
                app={app}
                onManageTools={() => {
                  if (finalProfile) {
                    // Use app if available, otherwise create from MCP data
                    const appToUse = app || {
                      name: integration.mcp.name || finalProfile.toolkit_name || 'Unknown',
                      slug: integration.mcp.toolkit_slug || finalProfile.toolkit_slug || '',
                      logo: '',
                      description: '',
                      categories: [],
                      connected: finalProfile.is_connected,
                    };
                    handleManageTools(appToUse, finalProfile);
                  }
                }}
                onDelete={() => handleDeleteIntegration(integration.mcp)}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}
