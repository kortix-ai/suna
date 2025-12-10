/**
 * Integrations Screen Component
 *
 * Allows configuring Composio app integrations for a worker
 * Shows connected apps and allows adding new ones
 */

import React, { useState, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Pressable,
  ActivityIndicator,
  Image,
  Alert,
  FlatList,
  TextInput,
  ScrollView,
} from 'react-native';
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
import {
  Plus,
  CheckCircle2,
  Settings,
  X,
  Store,
  Trash2,
  Server,
  Lock,
  Search,
  Plug,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { ComposioConnectorContent } from '@/components/settings/integrations/ComposioConnector';
import { ComposioToolsContent } from '@/components/settings/integrations/ComposioToolsSelector';
import { ComposioAppsContent } from '@/components/settings/integrations/ComposioAppsList';
import { CustomMcpContent } from '@/components/settings/integrations/CustomMcpDialog';
import { SvgUri } from 'react-native-svg';
import { useBillingContext } from '@/contexts/BillingContext';
import { FreeTierBlock } from '@/components/billing/FreeTierBlock';
import { useRouter } from 'expo-router';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetFlatList,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useLanguage } from '@/contexts/LanguageContext';
import { ToolkitIcon } from '@/components/settings/integrations/ToolkitIcon';
import { EmptyState } from '@/components/shared/EmptyState';

// Drawer view states
type DrawerView = 'apps' | 'connector' | 'tools';

interface IntegrationsScreenProps {
  agentId: string;
  onUpdate?: () => void;
  onUpgradePress?: () => void;
}

interface ActiveIntegrationCardProps {
  mcp: any;
  profile: ComposioProfile | null;
  app: ComposioApp | null;
  onManageTools: () => void;
  onDelete: () => void;
  isDeleting?: boolean;
}

function ActiveIntegrationCard({
  mcp,
  profile,
  app,
  onManageTools,
  onDelete,
  isDeleting = false,
}: ActiveIntegrationCardProps) {
  const { colorScheme } = useColorScheme();
  const enabledToolsCount = Array.isArray(mcp.enabledTools) ? mcp.enabledTools.length : 0;
  const isSvg = (url: string) =>
    url.toLowerCase().endsWith('.svg') || url.includes('composio.dev/api');

  // Check if this is a custom MCP (not composio)
  const isCustomMcp = mcp.type && ['http', 'sse', 'json'].includes(mcp.type);

  return (
    <View
      className="mb-3 rounded-2xl border border-border bg-card p-4"
      style={{ opacity: isDeleting ? 0.6 : 1 }}>
      {isDeleting && (
        <View
          className="absolute inset-0 z-10 items-center justify-center rounded-2xl"
          style={{
            backgroundColor:
              colorScheme === 'dark' ? 'rgba(24, 24, 27, 0.8)' : 'rgba(255, 255, 255, 0.8)',
          }}>
          <ActivityIndicator size="small" color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'} />
        </View>
      )}
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
          {!isCustomMcp && (
            <Pressable
              onPress={onManageTools}
              disabled={isDeleting}
              className="h-10 w-10 items-center justify-center rounded-lg bg-muted active:opacity-80"
              style={{ opacity: isDeleting ? 0.5 : 1 }}>
              <Icon as={Settings} size={18} className="text-foreground" />
            </Pressable>
          )}
          <Pressable
            onPress={onDelete}
            disabled={isDeleting}
            className="h-10 w-10 items-center justify-center rounded-lg bg-muted active:opacity-80"
            style={{ opacity: isDeleting ? 0.5 : 1 }}>
            {isDeleting ? (
              <ActivityIndicator
                size="small"
                color={colorScheme === 'dark' ? '#EF4444' : '#DC2626'}
              />
            ) : (
              <Icon as={Trash2} size={18} className="text-destructive" />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export function IntegrationsScreen({ agentId, onUpdate, onUpgradePress }: IntegrationsScreenProps) {
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const router = useRouter();
  const { data: agent, isLoading: isLoadingAgent } = useAgent(agentId);
  const { data: appsData, isLoading: isLoadingApps } = useComposioApps();
  const { data: profiles, isLoading: isLoadingProfiles } = useComposioProfiles();
  const updateAgentMutation = useUpdateAgent();
  const { hasFreeTier } = useBillingContext();

  const browseAppsSheetRef = useRef<BottomSheetModal>(null);
  const customMcpSheetRef = useRef<BottomSheetModal>(null);
  const toolsSheetRef = useRef<BottomSheetModal>(null);
  const [browseAppsSearchQuery, setBrowseAppsSearchQuery] = useState('');

  const [selectedApp, setSelectedApp] = useState<ComposioApp | null>(null);
  const [showConnector, setShowConnector] = useState(false);
  const [showBrowseApps, setShowBrowseApps] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<ComposioProfile | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);

  // Drawer multi-step state
  const [drawerView, setDrawerView] = useState<DrawerView>('apps');
  const [drawerSelectedApp, setDrawerSelectedApp] = useState<ComposioApp | null>(null);
  const [drawerSelectedProfile, setDrawerSelectedProfile] = useState<ComposioProfile | null>(null);
  const [isDrawerSaving, setIsDrawerSaving] = useState(false);

  // Custom MCP drawer button state
  const [customMcpButtonHandler, setCustomMcpButtonHandler] = useState<(() => void) | null>(null);
  const [customMcpButtonDisabled, setCustomMcpButtonDisabled] = useState(true);
  const [customMcpButtonLoading, setCustomMcpButtonLoading] = useState(false);

  // Tools sheet state
  const [toolsSheetApp, setToolsSheetApp] = useState<ComposioApp | null>(null);
  const [toolsSheetProfile, setToolsSheetProfile] = useState<ComposioProfile | null>(null);
  const [toolsSheetView, setToolsSheetView] = useState<'tools' | 'connector'>('tools');

  // Handle upgrade press - use provided callback or navigate to plans
  const handleUpgradePress = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (onUpgradePress) {
      onUpgradePress();
    } else {
      router.push('/plans');
    }
  }, [onUpgradePress, router]);

  const apps = appsData?.toolkits || [];

  // Get active integrations from custom_mcps
  // Show all composio integrations and custom MCPs, even if they have 0 tools enabled (like frontend)
  const activeIntegrations = useMemo(() => {
    if (!agent?.custom_mcps || !Array.isArray(agent.custom_mcps)) return [];

    return agent.custom_mcps
      .filter((mcp: any) => {
        // Include composio integrations with profile_id
        if (mcp.type === 'composio' && mcp.config?.profile_id) return true;
        // Include custom MCPs (http, sse, json types)
        if (['http', 'sse', 'json'].includes(mcp.type)) return true;
        return false;
      })
      .map((mcp: any) => {
        // For composio integrations
        if (mcp.type === 'composio' && mcp.config?.profile_id) {
          const profileId = mcp.config?.profile_id;
          const profile = profiles?.find((p: ComposioProfile) => p.profile_id === profileId);
          const toolkitSlug = mcp.toolkit_slug || mcp.config?.toolkit_slug;
          const app = apps.find((a: ComposioApp) => a.slug === toolkitSlug);

          return {
            mcp,
            profile: profile || null,
            app: app || null,
          };
        }
        // For custom MCPs
        return {
          mcp,
          profile: null,
          app: null,
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
            replace_mcps: true,
          },
        },
        {
          onSuccess: (updatedAgent) => {
            setShowConnector(false);
            setSelectedApp(null);
            onUpdate?.();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            // The agent query is automatically invalidated and updated by useUpdateAgent
            // The activeIntegrations will automatically update via useMemo when agent data changes
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
    // Open tools in a sheet
    setToolsSheetApp(finalApp);
    setToolsSheetProfile(profile);
    setToolsSheetView('tools');
    toolsSheetRef.current?.present();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleCloseToolsSheet = () => {
    toolsSheetRef.current?.dismiss();
    setToolsSheetApp(null);
    setToolsSheetProfile(null);
    setToolsSheetView('tools');
  };

  const handleToolsSheetComplete = () => {
    handleCloseToolsSheet();
    onUpdate?.();
  };

  const handleToolsSheetEdit = () => {
    // Switch to connector view within the tools sheet
    setToolsSheetView('connector');
  };

  const handleToolsSheetConnectorComplete = (
    profileId: string,
    appName: string,
    appSlug: string
  ) => {
    // After editing connection, go back to tools view
    // Update the profile reference
    const updatedProfile = profiles?.find((p: ComposioProfile) => p.profile_id === profileId);
    if (updatedProfile) {
      setToolsSheetProfile(updatedProfile);
    }
    setToolsSheetView('tools');
  };

  const handleDeleteIntegration = (mcp: any) => {
    const isCustomMcp = mcp.type && ['http', 'sse', 'json'].includes(mcp.type);
    const identifier = isCustomMcp ? mcp.config?.url : mcp.config?.profile_id;

    if (!identifier) return;

    Alert.alert(
      'Remove Integration',
      `Are you sure you want to remove the "${mcp.name}" integration? This will disconnect all associated tools and cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove Integration',
          style: 'destructive',
          onPress: () => {
            setDeletingProfileId(identifier);
            const customMcps = agent?.custom_mcps || [];
            const updatedMcps = customMcps.filter((existingMcp: any) => {
              if (isCustomMcp) {
                // For custom MCPs, match by URL
                return !(
                  (existingMcp.type === 'http' ||
                    existingMcp.type === 'sse' ||
                    existingMcp.type === 'json') &&
                  existingMcp.config?.url === mcp.config?.url
                );
              } else {
                // For composio, match by profile_id
                return !(
                  existingMcp.type === 'composio' && existingMcp.config?.profile_id === identifier
                );
              }
            });

            updateAgentMutation.mutate(
              {
                agentId,
                data: {
                  custom_mcps: updatedMcps,
                  replace_mcps: true,
                },
              },
              {
                onSuccess: () => {
                  setDeletingProfileId(null);
                  onUpdate?.();
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                },
                onError: (error: any) => {
                  setDeletingProfileId(null);
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
    // Stay in the drawer, just change the view to connector
    setDrawerSelectedApp(app);
    setDrawerView('connector');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleOpenBrowseApps = () => {
    setShowBrowseApps(true);
    setBrowseAppsSearchQuery('');
    setDrawerView('apps');
    setDrawerSelectedApp(null);
    setDrawerSelectedProfile(null);
    browseAppsSheetRef.current?.present();
  };

  const handleCloseBrowseApps = () => {
    browseAppsSheetRef.current?.dismiss();
    setShowBrowseApps(false);
    setBrowseAppsSearchQuery('');
    setDrawerView('apps');
    setDrawerSelectedApp(null);
    setDrawerSelectedProfile(null);
  };

  // Handle connector completion within drawer
  const handleDrawerConnectorComplete = (profileId: string, appName: string, appSlug: string) => {
    // Add the Composio MCP to the agent
    const customMcps = agent?.custom_mcps || [];
    const existingMcp = customMcps.find(
      (mcp: any) => mcp.type === 'composio' && mcp.config?.profile_id === profileId
    );

    if (!existingMcp) {
      setIsDrawerSaving(true);
      const newMcp = {
        name: appName,
        type: 'composio' as any,
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
            replace_mcps: true,
          },
        },
        {
          onSuccess: () => {
            setIsDrawerSaving(false);
            // Find the profile and move to tools view
            const profile = profiles?.find((p: ComposioProfile) => p.profile_id === profileId);
            if (profile) {
              setDrawerSelectedProfile(profile);
              setDrawerView('tools');
            } else {
              // Close drawer if no profile found
              handleCloseBrowseApps();
            }
            onUpdate?.();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
          onError: (error: any) => {
            setIsDrawerSaving(false);
            Alert.alert('Error', error?.message || 'Failed to add integration');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          },
        }
      );
    } else {
      // Already exists, just move to tools
      const profile = profiles?.find((p: ComposioProfile) => p.profile_id === profileId);
      if (profile) {
        setDrawerSelectedProfile(profile);
        setDrawerView('tools');
      } else {
        handleCloseBrowseApps();
      }
    }
  };

  // Handle tools completion within drawer
  const handleDrawerToolsComplete = () => {
    handleCloseBrowseApps();
    onUpdate?.();
  };

  // Handle back navigation within drawer
  const handleDrawerBack = () => {
    if (drawerView === 'tools') {
      // From tools, go back to connector (or close if profile already existed)
      setDrawerView('connector');
      setDrawerSelectedProfile(null);
    } else if (drawerView === 'connector') {
      // From connector, go back to apps list
      setDrawerView('apps');
      setDrawerSelectedApp(null);
    } else {
      // From apps, close drawer
      handleCloseBrowseApps();
    }
  };

  // Check if an app is connected to the agent
  const isAppConnectedToAgent = useCallback(
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

  // Filter apps based on search query
  const filteredBrowseApps = useMemo(() => {
    if (!browseAppsSearchQuery.trim()) return apps;
    const query = browseAppsSearchQuery.toLowerCase();
    return apps.filter(
      (app: ComposioApp) =>
        app.name.toLowerCase().includes(query) ||
        app.description?.toLowerCase().includes(query) ||
        app.categories?.some((cat) => cat.toLowerCase().includes(query))
    );
  }, [apps, browseAppsSearchQuery]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    []
  );

  const handleCustomMcpSave = (config: any) => {
    // Check if this is the initial discovery call (with tool objects) or the final save (with tool names)
    // If tools is an array of objects, it's the discovery call - we should ignore it
    // If tools is an array of strings, it's the final save - we should process it
    const tools = config.tools || [];
    const isToolObjects =
      tools.length > 0 && typeof tools[0] === 'object' && tools[0].name !== undefined;

    // Only save if this is the final save with tool names (strings)
    if (isToolObjects) {
      // This is the discovery call, just return without saving
      return;
    }

    const customMcps = agent?.custom_mcps || [];

    // Create the custom MCP configuration
    const newMcp = {
      name: config.serverName,
      type: config.type || 'sse', // Backend expects 'sse' for HTTP-based MCPs
      config: {
        url: config.url,
      },
      enabledTools: tools, // Array of tool names (strings)
    };

    // Check if MCP with same URL already exists
    const existingMcp = customMcps.find(
      (mcp: any) =>
        (mcp.type === 'sse' || mcp.type === 'http' || mcp.type === 'json') &&
        mcp.config?.url === config.url
    );

    if (!existingMcp) {
      updateAgentMutation.mutate(
        {
          agentId,
          data: {
            custom_mcps: [...customMcps, newMcp],
            replace_mcps: true,
          },
        },
        {
          onSuccess: () => {
            // Close the Custom MCP drawer
            handleCloseCustomMcp();
            onUpdate?.();
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
          onError: (error: any) => {
            Alert.alert('Error', error?.message || 'Failed to add custom MCP');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          },
        }
      );
    } else {
      // MCP already exists, close the Custom MCP drawer
      handleCloseCustomMcp();
    }
  };

  const handleOpenCustomMcp = () => {
    customMcpSheetRef.current?.present();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleCloseCustomMcp = () => {
    customMcpSheetRef.current?.dismiss();
    // Reset button state
    setCustomMcpButtonHandler(null);
    setCustomMcpButtonDisabled(true);
    setCustomMcpButtonLoading(false);
  };

  const handleDiscoverToolsReady = useCallback(
    (handler: () => void, disabled: boolean, loading: boolean) => {
      setCustomMcpButtonHandler(() => handler);
      setCustomMcpButtonDisabled(disabled);
      setCustomMcpButtonLoading(loading);
    },
    []
  );

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
      <ComposioConnectorContent
        app={selectedApp}
        onBack={() => {
          setShowConnector(false);
          setSelectedApp(null);
        }}
        onComplete={handleConnectorComplete}
        agentId={agentId}
        mode="full"
        isSaving={updateAgentMutation.isPending}
      />
    );
  }

  // Show free tier block if user is on free tier
  if (hasFreeTier) {
    return (
      <View className="flex-1 items-center justify-center px-4 py-8">
        <FreeTierBlock variant="integrations" onUpgradePress={handleUpgradePress} style="card" />
      </View>
    );
  }

  return (
    <View className="space-y-4">
      {/* Header - matching Triggers screen style */}
      <View className="mb-2 flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <Text className="mb-2 font-roobert-semibold text-base text-foreground">Integrations</Text>
          <Text className="font-roobert text-sm text-muted-foreground">
            Connect apps and custom MCP servers to extend your worker
          </Text>
        </View>
      </View>

      {/* Browse Apps and Custom MCP Buttons - only show when there are integrations */}
      {activeIntegrations.length > 0 && (
        <View className="mb-4 flex-row gap-3">
          <Pressable
            onPress={handleOpenBrowseApps}
            className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-80">
            <Icon as={Store} size={18} className="text-foreground" />
            <Text className="font-roobert-semibold text-base text-foreground">Browse Apps</Text>
          </Pressable>
          <Pressable
            onPress={handleOpenCustomMcp}
            className="flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 active:opacity-80">
            <Icon as={Server} size={18} className="text-foreground" />
            <Text className="font-roobert-semibold text-base text-foreground">Custom MCP</Text>
          </Pressable>
        </View>
      )}

      {/* Active Integrations List */}
      {activeIntegrations.length === 0 ? (
        <View className="items-center justify-center rounded-2xl border border-border bg-card p-8">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-xl bg-muted">
            <Icon as={Plug} size={24} className="text-muted-foreground" />
          </View>
          <Text className="mb-1 font-roobert-semibold text-base text-foreground">
            No integrations configured
          </Text>
          <Text className="mb-4 text-center text-sm text-muted-foreground">
            Browse the app registry to connect your apps or add custom MCP servers
          </Text>
          {/* Browse Apps and Custom MCP Buttons in empty state - matching EmptyState button style */}
          <View className="w-full flex-row gap-3">
            <Pressable
              onPress={handleOpenBrowseApps}
              className="flex-1 rounded-xl bg-primary px-4 py-2 active:opacity-80">
              <Text className="text-center font-roobert-semibold text-sm text-primary-foreground">
                Browse Apps
              </Text>
            </Pressable>
            <Pressable
              onPress={handleOpenCustomMcp}
              className="flex-1 rounded-xl bg-primary px-4 py-2 active:opacity-80">
              <Text className="text-center font-roobert-semibold text-sm text-primary-foreground">
                Custom MCP
              </Text>
            </Pressable>
          </View>
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

            const isCustomMcp =
              integration.mcp.type && ['http', 'sse', 'json'].includes(integration.mcp.type);
            const identifier = isCustomMcp
              ? integration.mcp.config?.url
              : integration.mcp.config?.profile_id;
            const isDeleting = deletingProfileId === identifier;

            return (
              <ActiveIntegrationCard
                key={`${identifier || index}`}
                mcp={integration.mcp}
                profile={finalProfile}
                app={app}
                isDeleting={isDeleting}
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

      {/* Browse Apps Drawer */}
      <BottomSheetModal
        ref={browseAppsSheetRef}
        snapPoints={['90%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        onDismiss={handleCloseBrowseApps}
        backdropComponent={renderBackdrop}
        backgroundStyle={{
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
        }}
        handleIndicatorStyle={{
          backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
          marginTop: 8,
          marginBottom: 0,
        }}
        style={{
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: 'hidden',
        }}>
        <View style={{ flex: 1 }}>
          {/* Apps List View */}
          {drawerView === 'apps' && (
            <View style={{ flex: 1, flexDirection: 'column' }}>
              {/* Sticky Header */}
              <View
                style={{
                  paddingHorizontal: 24,
                  paddingTop: 16,
                  paddingBottom: 16,
                  backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
                }}>
                <Text className="mb-2 font-roobert-semibold text-xl text-foreground">
                  {t('integrations.composioApps')}
                </Text>
                <Text className="mb-4 font-roobert text-sm text-muted-foreground">
                  {t('integrations.composioAppsDescription')}
                </Text>

                {/* Search Bar */}
                <View>
                  <View
                    className="flex-row items-center rounded-2xl border border-border bg-card px-4"
                    style={{
                      backgroundColor: colorScheme === 'dark' ? '#27272A' : '#FFFFFF',
                      borderColor: colorScheme === 'dark' ? '#3F3F46' : '#E4E4E7',
                    }}>
                    <Icon as={Search} size={18} className="text-muted-foreground" />
                    <TextInput
                      value={browseAppsSearchQuery}
                      onChangeText={setBrowseAppsSearchQuery}
                      placeholder={t('composio.searchApps')}
                      placeholderTextColor={colorScheme === 'dark' ? '#71717A' : '#A1A1AA'}
                      className="ml-3 flex-1 py-3 font-roobert text-base text-foreground"
                      style={{
                        color: colorScheme === 'dark' ? '#F8F8F8' : '#121215',
                      }}
                    />
                    {browseAppsSearchQuery.length > 0 && (
                      <Pressable onPress={() => setBrowseAppsSearchQuery('')} className="ml-2">
                        <Icon as={X} size={18} className="text-muted-foreground" />
                      </Pressable>
                    )}
                  </View>
                </View>
              </View>

              {/* Scrollable Apps List */}
              {isLoadingApps ? (
                <View
                  className="flex-1 items-center justify-center"
                  style={{ paddingHorizontal: 24 }}>
                  <ActivityIndicator
                    size="small"
                    color={colorScheme === 'dark' ? '#FFFFFF' : '#121215'}
                  />
                  <Text className="mt-4 font-roobert text-sm text-muted-foreground">
                    {t('integrations.loadingIntegrations')}
                  </Text>
                </View>
              ) : (
                <BottomSheetFlatList
                  data={filteredBrowseApps}
                  keyExtractor={(item: ComposioApp) => item.slug}
                  style={{ flex: 1 }}
                  renderItem={({ item: app }: { item: ComposioApp }) => {
                    const isConnected = agentId ? isAppConnectedToAgent(app.slug) : false;
                    return (
                      <View style={{ paddingHorizontal: 24 }}>
                        <Pressable
                          onPress={() => handleBrowseAppSelect(app)}
                          disabled={isConnected}
                          className={`mb-3 flex-row items-center gap-4 rounded-2xl p-4 ${
                            isConnected ? 'bg-muted/5 opacity-50' : 'bg-primary/5 active:opacity-80'
                          }`}>
                          <ToolkitIcon slug={app.slug} name={app.name} size="sm" />
                          <View className="flex-1">
                            <Text
                              className={`font-roobert-semibold text-base ${
                                isConnected ? 'text-muted-foreground' : 'text-foreground'
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
                              <View className="mt-1 flex-row items-center gap-1">
                                <Icon
                                  as={CheckCircle2}
                                  size={12}
                                  className="text-green-600 dark:text-green-400"
                                />
                                <Text className="text-xs font-medium text-green-600 dark:text-green-400">
                                  {t('triggers.connected')}
                                </Text>
                              </View>
                            )}
                          </View>
                        </Pressable>
                      </View>
                    );
                  }}
                  contentContainerStyle={{ paddingBottom: 60, paddingTop: 8, flexGrow: 1 }}
                  showsVerticalScrollIndicator={true}
                  bounces={true}
                  maxToRenderPerBatch={10}
                  updateCellsBatchingPeriod={50}
                  initialNumToRender={20}
                  windowSize={21}
                  ListEmptyComponent={
                    <View style={{ paddingHorizontal: 24, paddingVertical: 32 }}>
                      <EmptyState
                        icon={Search}
                        title={
                          browseAppsSearchQuery
                            ? t('integrations.noAppsFound')
                            : t('integrations.noAppsAvailable')
                        }
                        description={
                          browseAppsSearchQuery
                            ? t('integrations.tryDifferentSearch')
                            : t('integrations.appsAppearHere')
                        }
                      />
                    </View>
                  }
                />
              )}
            </View>
          )}

          {/* Connector View */}
          {drawerView === 'connector' && drawerSelectedApp && (
            <ComposioConnectorContent
              app={drawerSelectedApp}
              onBack={handleDrawerBack}
              onComplete={handleDrawerConnectorComplete}
              onNavigateToTools={(app, profile) => {
                setDrawerSelectedApp(app);
                setDrawerSelectedProfile(profile);
                setDrawerView('tools');
              }}
              agentId={agentId}
              mode="full"
              noPadding={false}
              isSaving={isDrawerSaving}
              useBottomSheetFlatList={true}
            />
          )}

          {/* Tools View */}
          {drawerView === 'tools' && drawerSelectedApp && drawerSelectedProfile && (
            <ComposioToolsContent
              app={drawerSelectedApp}
              profile={drawerSelectedProfile}
              agentId={agentId}
              onBack={handleDrawerBack}
              onComplete={handleDrawerToolsComplete}
              noPadding={false}
              useBottomSheetFlatList={true}
            />
          )}
        </View>
      </BottomSheetModal>

      {/* Custom MCP Drawer */}
      <BottomSheetModal
        ref={customMcpSheetRef}
        snapPoints={['90%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        onDismiss={handleCloseCustomMcp}
        backdropComponent={renderBackdrop}
        backgroundStyle={{
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
        }}
        handleIndicatorStyle={{
          backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
          marginTop: 8,
          marginBottom: 0,
        }}
        style={{
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: 'hidden',
        }}>
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
              {t('integrations.customMcp.title')}
            </Text>
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              {t('integrations.customMcp.description')}
            </Text>
          </View>

          {/* Scrollable Content */}
          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 16 }}
            showsVerticalScrollIndicator={false}>
            <CustomMcpContent
              onSave={handleCustomMcpSave}
              noPadding={true}
              hideBackButton={true}
              hideButton={true}
              onDiscoverToolsReady={handleDiscoverToolsReady}
            />
          </BottomSheetScrollView>

          {/* Fixed Footer Button */}
          <View
            style={{
              paddingHorizontal: 24,
              paddingTop: 16,
              paddingBottom: 24,
              backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
            }}>
            <Pressable
              onPress={() => customMcpButtonHandler?.()}
              disabled={customMcpButtonDisabled}
              className={`w-full items-center rounded-2xl py-4 ${
                customMcpButtonDisabled ? 'bg-muted/20' : 'bg-foreground'
              }`}>
              <View className="flex-row items-center gap-2">
                {customMcpButtonLoading && (
                  <ActivityIndicator
                    size="small"
                    color={colorScheme === 'dark' ? '#FFFFFF' : '#FFFFFF'}
                  />
                )}
                <Text
                  className={`font-roobert-semibold text-base ${
                    customMcpButtonDisabled ? 'text-muted-foreground' : 'text-background'
                  }`}>
                  {customMcpButtonLoading
                    ? t('integrations.customMcp.discoveringTools')
                    : t('integrations.customMcp.discoverTools')}
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      </BottomSheetModal>

      {/* Tools Manager Sheet (for editing existing integrations) */}
      <BottomSheetModal
        ref={toolsSheetRef}
        snapPoints={['90%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        onDismiss={handleCloseToolsSheet}
        backdropComponent={renderBackdrop}
        backgroundStyle={{
          backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
        }}
        handleIndicatorStyle={{
          backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
          marginTop: 8,
          marginBottom: 0,
        }}
        style={{
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          overflow: 'hidden',
        }}>
        <View style={{ flex: 1 }}>
          {/* Tools View */}
          {toolsSheetView === 'tools' && toolsSheetApp && toolsSheetProfile && (
            <ComposioToolsContent
              app={toolsSheetApp}
              profile={toolsSheetProfile}
              agentId={agentId}
              onComplete={handleToolsSheetComplete}
              onEdit={handleToolsSheetEdit}
              noPadding={false}
              useBottomSheetFlatList={true}
            />
          )}

          {/* Connector View (for editing connection) */}
          {toolsSheetView === 'connector' && toolsSheetApp && (
            <ComposioConnectorContent
              app={toolsSheetApp}
              onBack={() => setToolsSheetView('tools')}
              onComplete={handleToolsSheetConnectorComplete}
              onNavigateToTools={(app, profile) => {
                setToolsSheetApp(app);
                setToolsSheetProfile(profile);
                setToolsSheetView('tools');
              }}
              agentId={agentId}
              mode="full"
              noPadding={false}
              isSaving={false}
              useBottomSheetFlatList={true}
            />
          )}
        </View>
      </BottomSheetModal>
    </View>
  );
}
