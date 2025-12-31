import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { SearchBar } from '@/components/ui/SearchBar';
import { useLanguage } from '@/contexts';
import { useAgent } from '@/contexts/AgentContext';
import { useAdvancedFeatures } from '@/hooks';
import { useBillingContext } from '@/contexts/BillingContext';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetView,
  BottomSheetModal,
  BottomSheetFlatList,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import {
  Plus,
  Check,
  Briefcase,
  FileText,
  BookOpen,
  Zap,
  Layers,
  Search as SearchIcon,
  ChevronRight,
  ArrowLeft,
  Crown,
  DollarSign,
  Plug,
  Brain,
  Wrench,
  Server,
  Sparkles,
  Lock,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as React from 'react';
import { Pressable, View, ScrollView, Keyboard, Alert, Platform, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  withTiming,
  useSharedValue,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { AgentAvatar } from './AgentAvatar';
import { ModelAvatar } from '@/components/models/ModelAvatar';
import { ModelToggle } from '@/components/models/ModelToggle';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { EntityList } from '@/components/shared/EntityList';
import { useSearch } from '@/lib/utils/search';
import { useAvailableModels } from '@/lib/models';
import type { Agent, Model } from '@/api/types';
import {
  AppBubble,
  IntegrationsPage,
  IntegrationsPageContent,
} from '@/components/settings/IntegrationsPage';
import { ComposioAppsContent } from '@/components/settings/integrations/ComposioAppsList';
import { ComposioAppDetailContent } from '@/components/settings/integrations/ComposioAppDetail';
import { ComposioConnectorContent } from '@/components/settings/integrations/ComposioConnector';
import { ComposioToolsContent } from '@/components/settings/integrations/ComposioToolsSelector';
import { CustomMcpContent } from '@/components/settings/integrations/CustomMcpDialog';
import { CustomMcpToolsContent } from '@/components/settings/integrations/CustomMcpToolsSelector';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import { ToolkitIcon } from '../settings/integrations/ToolkitIcon';

interface AgentDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCreateAgent?: () => void;
  onOpenWorkerConfig?: (
    workerId: string,
    view?: 'instructions' | 'tools' | 'integrations' | 'triggers'
  ) => void;
  onDismiss?: () => void;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
type ViewState =
  | 'main'
  | 'agents'
  | 'integrations'
  | 'composio'
  | 'composio-detail'
  | 'composio-connector'
  | 'composio-tools'
  | 'customMcp'
  | 'customMcp-tools';

function BackButton({ onPress }: { onPress: () => void }) {
  const { colorScheme } = useColorScheme();

  return (
    <BottomSheetTouchable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', opacity: 1 }}>
      <ArrowLeft size={20} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
    </BottomSheetTouchable>
  );
}

export function AgentDrawer({
  visible,
  onClose,
  onCreateAgent,
  onOpenWorkerConfig,
  onDismiss,
}: AgentDrawerProps) {
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const { isEnabled: advancedFeaturesEnabled } = useAdvancedFeatures();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const agentContext = useAgent();
  const {
    agents,
    selectedAgentId,
    selectedModelId,
    selectAgent,
    selectModel,
    isLoading,
    hasInitialized,
    loadAgents,
  } = agentContext;

  const { data: modelsData, isLoading: modelsLoading } = useAvailableModels();

  const { hasActiveSubscription, subscriptionData, hasFreeTier } = useBillingContext();

  const models = modelsData?.models || [];
  const selectedAgent = agents.find((a) => a.agent_id === selectedAgentId);

  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<number | null>(null);

  const selectedModel = React.useMemo(() => {
    if (selectedModelId) {
      const model = models.find((m) => m.id === selectedModelId);
      if (model) return model;
    }
    return models.find((m) => m.id === selectedAgent?.model) || models.find((m) => m.recommended);
  }, [selectedModelId, models, selectedAgent]);

  const [currentView, setCurrentView] = React.useState<ViewState>('main');
  const [selectedComposioApp, setSelectedComposioApp] = React.useState<any>(null);
  const [selectedComposioProfile, setSelectedComposioProfile] = React.useState<any>(null);
  const [customMcpConfig, setCustomMcpConfig] = React.useState<{
    serverName: string;
    url: string;
    tools: any[];
  } | null>(null);

  const searchableAgents = React.useMemo(
    () => agents.map((agent) => ({ ...agent, id: agent.agent_id })),
    [agents]
  );
  const {
    query: agentQuery,
    results: agentResults,
    clearSearch: clearAgentSearch,
    updateQuery: updateAgentQuery,
  } = useSearch(searchableAgents, ['name', 'description']);
  const processedAgentResults = React.useMemo(
    () => agentResults.map((result) => ({ ...result, agent_id: result.id })),
    [agentResults]
  );

  // Check if user can access a model
  const canAccessModel = React.useCallback(
    (model: Model) => {
      // If model doesn't require subscription, it's accessible
      if (!model.requires_subscription) return true;
      // Model requires subscription - user must have PAID subscription (not free tier)
      return hasActiveSubscription && !hasFreeTier;
    },
    [hasActiveSubscription, hasFreeTier]
  );

  // Handle model change from the toggle
  const handleModelChange = React.useCallback(
    (modelId: string) => {
      console.log('🎯 Model Changed via Toggle:', modelId);
      if (selectModel) {
        selectModel(modelId);
      }
    },
    [selectModel]
  );

  // Handle upgrade required - navigate to plans page
  const handleUpgradeRequired = React.useCallback(() => {
    console.log('🔒 Upgrade required - navigating to plans');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onClose?.();
    // Small delay to allow drawer to close before navigation
    setTimeout(() => {
      router.push('/plans');
    }, 100);
  }, [onClose, router]);

  // Track actual drawer state changes
  const handleSheetChange = React.useCallback(
    (index: number) => {
      console.log('🎭 [AgentDrawer] Sheet index changed:', index, '| Resetting guard');
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (index === -1) {
        // Drawer fully closed - reset guard immediately
        console.log('🎭 [AgentDrawer] Drawer closed - guard reset');
        isOpeningRef.current = false;
        onClose?.();
      } else if (index >= 0) {
        // Drawer opened successfully - can safely reset guard
        console.log('🎭 [AgentDrawer] Drawer opened - guard reset');
        isOpeningRef.current = false;
      }
    },
    [onClose]
  );

  // Handle dismiss
  const handleDismiss = React.useCallback(() => {
    console.log('🎭 [AgentDrawer] Sheet dismissed');
    isOpeningRef.current = false;
    onClose?.();
    onDismiss?.();
  }, [onClose, onDismiss]);

  // Handle visibility changes
  React.useEffect(() => {
    console.log('🎭 [AgentDrawer] Visibility changed:', visible, '| Guard:', isOpeningRef.current);
    if (visible && !isOpeningRef.current) {
      console.log('✅ [AgentDrawer] Opening drawer with haptic feedback');
      isOpeningRef.current = true;

      // Fallback: reset guard after 500ms if onChange doesn't fire
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        console.log('🎭 [AgentDrawer] Fallback timeout - resetting guard');
        isOpeningRef.current = false;
      }, 500);

      // Ensure keyboard is dismissed when drawer opens
      Keyboard.dismiss();

      // Refetch agents when drawer opens to ensure fresh data
      console.log('🔄 Refetching agents when drawer opens...');
      loadAgents();

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetRef.current?.present();
      setCurrentView('main'); // Reset to main view when opening
    } else if (!visible) {
      console.log('❌ [AgentDrawer] Closing drawer');
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      bottomSheetRef.current?.dismiss();
      // Clear searches when closing
      clearAgentSearch();
    }
  }, [visible, clearAgentSearch, loadAgents, handleSheetChange]);

  // Navigation functions
  const navigateToView = React.useCallback((view: ViewState) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView(view);
  }, []);

  const handleAgentPress = React.useCallback(
    async (agent: Agent) => {
      console.log('🤖 Agent Selected:', agent.name);
      await selectAgent(agent.agent_id);
      navigateToView('main');
    },
    [selectAgent, navigateToView]
  );

  const integrationsScale = useSharedValue(1);

  const integrationsAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: integrationsScale.value }],
  }));

  const handleIntegrationsPress = React.useCallback(() => {
    console.log('🔌 Integrations pressed');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    // Block free tier users from accessing integrations
    if (hasFreeTier) {
      handleUpgradeRequired();
      return;
    }

    if (!selectedAgent) {
      Alert.alert(
        'No Worker Selected',
        'Please select a worker first before configuring integrations.',
        [{ text: 'OK' }]
      );
      return;
    }

    setCurrentView('integrations');
  }, [selectedAgent, hasFreeTier, handleUpgradeRequired]);

  const handleIntegrationsPressIn = React.useCallback(() => {
    integrationsScale.value = withTiming(0.95, { duration: 100 });
  }, []);

  const handleIntegrationsPressOut = React.useCallback(() => {
    integrationsScale.value = withTiming(1, { duration: 100 });
  }, []);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    []
  );

  // Define model options for the list
  const modelOptions = React.useMemo(() => {
    const basicModel = models.find((m) => !m.requires_subscription);
    const advancedModel = models.find((m) => m.requires_subscription);

    return [
      {
        id: 'basic',
        modelId: basicModel?.id || 'gpt-4o-mini',
        name: 'Basic',
        description: 'Fastest, useful for everyday tasks.',
        icon: require('@/assets/images/Basic-Agent.png'),
        isLocked: false,
      },
      {
        id: 'advanced',
        modelId: advancedModel?.id || 'o1',
        name: 'Advanced',
        description: 'Best for reasoning and heavy usage.',
        icon: require('@/assets/images/Advanced-Agent.png'),
        isLocked: hasFreeTier,
      },
    ];
  }, [models, hasFreeTier]);

  // Handle model selection
  const handleModelPress = React.useCallback(
    (option: typeof modelOptions[0]) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      if (option.isLocked) {
        handleUpgradeRequired();
        return;
      }

      // Select the model
      if (selectModel) {
        selectModel(option.modelId);
      }

      // Close the drawer after a short delay
      setTimeout(() => {
        onClose?.();
      }, 200);
    },
    [selectModel, handleUpgradeRequired, onClose]
  );

  // Get currently selected option
  const getSelectedOption = React.useCallback(() => {
    const currentModel = models.find((m) => m.id === selectedModelId);
    if (!currentModel) return 'basic';

    return currentModel.requires_subscription ? 'advanced' : 'basic';
  }, [models, selectedModelId]);

  const renderMainView = () => (
    <View>
      {/* Models Section */}
      <View className="pb-0 pt-2">
        <View className="px-4 mb-3">
          <Text
            style={{
              color: colorScheme === 'dark' ? '#F8F8F8' : '#121215',
            }}
            className="font-roobert-medium text-base">
            Models
          </Text>
        </View>

        {/* Model List */}
        {modelsLoading ? (
          <View className="items-center py-8">
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              Loading...
            </Text>
          </View>
        ) : (
          <View className="gap-2">
            {modelOptions.map((option) => {
              const isSelected = getSelectedOption() === option.id;

              return (
                <BottomSheetTouchable
                  key={option.id}
                  style={{
                    backgroundColor: isSelected 
                      ? (colorScheme === 'dark' ? '#232324' : '#E5E5E5')
                      : 'transparent',
                    borderRadius: 9999,
                    paddingVertical: 16,
                    paddingLeft: 16,
                    paddingRight: 24,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 16,
                  }}
                  onPress={() => handleModelPress(option)}>
                  {/* Model Icon */}
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      overflow: 'hidden',
                    }}>
                    <Image
                      source={option.icon}
                      style={{ width: 40, height: 40 }}
                      resizeMode="cover"
                    />
                  </View>

                  {/* Model Info */}
                  <View style={{ flex: 1, gap: 1 }}>
                    <Text
                      style={{
                        color: colorScheme === 'dark' ? '#F8F8F8' : '#121215',
                        fontSize: 16,
                        fontFamily: 'Roobert-Medium',
                      }}>
                      {option.name}
                    </Text>
                    <Text
                      className="text-sm text-neutral-600"
                      style={{
                        fontFamily: 'Roobert-Regular',
                      }}>
                      {option.description}
                    </Text>
                  </View>

                  {/* Right side - Lock icon only */}
                  {option.isLocked && (
                    <View style={{ opacity: 0.5 }}>
                      <Lock
                        size={20}
                        color={colorScheme === 'dark' ? '#F8F8F8' : '#121215'}
                      />
                    </View>
                  )}
                </BottomSheetTouchable>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );

  // Simplified agents view - hidden but kept for potential future use
  const renderAgentsView = () => (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 24 }}
      keyboardShouldPersistTaps="handled">
      <View className="mb-4 flex-row items-center">
        <BackButton onPress={() => setCurrentView('main')} />
        <Text
          style={{ color: colorScheme === 'dark' ? '#F8F8F8' : '#121215' }}
          className="ml-2 font-roobert-medium text-lg">
          {t('agents.myWorkers')}
        </Text>
      </View>

      <EntityList
        entities={agentQuery ? processedAgentResults : agents}
        isLoading={isLoading}
        emptyMessage="No workers available"
        searchQuery={agentQuery}
        renderItem={(agent: Agent) => (
          <SelectableListItem
            key={agent.agent_id}
            avatar={<AgentAvatar agent={agent} size={48} />}
            title={agent.name}
            subtitle={agent.description}
            isSelected={agent.agent_id === selectedAgentId}
            onPress={() => handleAgentPress(agent)}
            accessibilityLabel={`Select ${agent.name} worker`}
          />
        )}
      />
    </ScrollView>
  );

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      enableDynamicSizing
      enablePanDownToClose
      onDismiss={handleDismiss}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
        borderTopLeftRadius: 38,
        borderTopRightRadius: 38,
      }}
      handleIndicatorStyle={{
        backgroundColor: colorScheme === 'dark' ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
      style={{
        zIndex: 50,
        elevation: Platform.OS === 'android' ? 10 : undefined,
      }}>
      {/* Use BottomSheetFlatList directly for composio, composio-detail, and composio-connector views */}
      {['composio', 'composio-detail', 'composio-connector'].includes(currentView) ? (
        currentView === 'composio' ? (
          <ComposioAppsContent
            onBack={() => setCurrentView('integrations')}
            onAppSelect={(app) => {
              setSelectedComposioApp(app);
              setCurrentView('composio-detail');
            }}
            noPadding={true}
            useBottomSheetFlatList={true}
          />
        ) : currentView === 'composio-detail' && selectedComposioApp ? (
          <ComposioAppDetailContent
            app={selectedComposioApp}
            onBack={() => setCurrentView('composio')}
            onComplete={() => setCurrentView('integrations')}
            onNavigateToConnector={(app) => {
              setSelectedComposioApp(app);
              setCurrentView('composio-connector');
            }}
            onNavigateToTools={(app, profile) => {
              setSelectedComposioApp(app);
              setSelectedComposioProfile(profile);
              setCurrentView('composio-tools');
            }}
            noPadding={true}
            useBottomSheetFlatList={true}
          />
        ) : currentView === 'composio-connector' && selectedComposioApp && selectedAgent ? (
          <ComposioConnectorContent
            app={selectedComposioApp}
            onBack={() => setCurrentView('composio-detail')}
            onComplete={(profileId, appName, appSlug) => {
              console.log('✅ Composio connector completed');
              setCurrentView('integrations');
            }}
            onNavigateToTools={(app, profile) => {
              setSelectedComposioApp(app);
              setSelectedComposioProfile(profile);
              setCurrentView('composio-tools');
            }}
            mode="full"
            agentId={selectedAgent.agent_id}
            noPadding={true}
            useBottomSheetFlatList={true}
          />
        ) : null
      ) : ['composio-tools', 'customMcp-tools'].includes(currentView) ? (
        <BottomSheetView
          style={{
            paddingHorizontal: 24,
            paddingTop: 24,
            paddingBottom: 32,
            flex: 1,
          }}>
          {currentView === 'composio-tools' &&
            selectedComposioApp &&
            selectedComposioProfile &&
            selectedAgent && (
              <Animated.View
                entering={FadeIn.duration(300)}
                exiting={FadeOut.duration(200)}
                style={{ flex: 1 }}>
                <ComposioToolsContent
                  app={selectedComposioApp}
                  profile={selectedComposioProfile}
                  agentId={selectedAgent.agent_id}
                  onBack={() => setCurrentView('composio-detail')}
                  onComplete={() => {
                    console.log('✅ Composio tools configured');
                    setCurrentView('integrations');
                  }}
                  noPadding={true}
                />
              </Animated.View>
            )}

          {currentView === 'customMcp-tools' && customMcpConfig && (
            <Animated.View
              entering={FadeIn.duration(300)}
              exiting={FadeOut.duration(200)}
              style={{ flex: 1 }}>
              <CustomMcpToolsContent
                serverName={customMcpConfig.serverName}
                url={customMcpConfig.url}
                tools={customMcpConfig.tools}
                onBack={() => setCurrentView('customMcp')}
                onComplete={(enabledTools) => {
                  console.log('✅ Custom MCP tools configured:', enabledTools);
                  Alert.alert(
                    t('integrations.customMcp.toolsConfigured'),
                    t('integrations.customMcp.toolsConfiguredMessage', {
                      count: enabledTools.length,
                    })
                  );
                  setCurrentView('integrations');
                }}
                noPadding={true}
              />
            </Animated.View>
          )}
        </BottomSheetView>
      ) : (
        <BottomSheetScrollView
          contentContainerStyle={{
            paddingHorizontal: 8,
            paddingTop: 0,
            paddingBottom: 40,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {/* Dynamic content based on current view */}
          {currentView === 'main' && (
            <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
              {renderMainView()}
            </Animated.View>
          )}

          {currentView === 'agents' && (
            <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
              {renderAgentsView()}
            </Animated.View>
          )}

          {currentView === 'integrations' && (
            <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
              <IntegrationsPageContent
                onBack={() => setCurrentView('main')}
                noPadding={true}
                onNavigate={(view) => setCurrentView(view as ViewState)}
                onUpgradePress={handleUpgradeRequired}
              />
            </Animated.View>
          )}

          {currentView === 'customMcp' && (
            <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)}>
              <CustomMcpContent
                onBack={() => setCurrentView('integrations')}
                noPadding={true}
                onSave={(config) => {
                  console.log('Custom MCP config:', config);
                  // Store the config and navigate to tools selector
                  setCustomMcpConfig({
                    serverName: config.serverName,
                    url: config.url,
                    tools: config.tools || [],
                  });
                  setCurrentView('customMcp-tools');
                }}
              />
            </Animated.View>
          )}
        </BottomSheetScrollView>
      )}
    </BottomSheetModal>
  );
}
