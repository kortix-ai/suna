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
import { Pressable, View, ScrollView, Keyboard, Alert, Platform } from 'react-native';
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

  const renderMainView = () => (
    <View>
      <View className="pb-3" style={{ overflow: 'visible' }}>
        <View className="mb-3 flex-row items-center justify-between">
          <Text
            style={{
              color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)',
            }}
            className="font-roobert-medium text-sm">
            {t('agents.myWorkers')}
          </Text>
          {onCreateAgent && (
            <BottomSheetTouchable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (hasFreeTier) {
                  handleUpgradeRequired();
                } else {
                  onCreateAgent();
                }
              }}>
              {hasFreeTier ? (
                <Sparkles size={18} color={colorScheme === 'dark' ? '#22c55e' : '#16a34a'} />
              ) : (
                <Plus
                  size={18}
                  color={
                    colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'
                  }
                />
              )}
            </BottomSheetTouchable>
          )}
        </View>

        {/* Selected Worker - Clickable */}
        {selectedAgent ? (
          <SelectableListItem
            avatar={<AgentAvatar agent={selectedAgent} size={48} />}
            title={selectedAgent.name}
            subtitle={selectedAgent.description}
            showChevron
            onPress={() => navigateToView('agents')}
          />
        ) : (
          <View className="items-center py-4">
            <Text
              style={{
                color:
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
              }}
              className="font-roobert text-sm">
              {isLoading || !hasInitialized ? t('loading.threads') : 'No worker selected'}
            </Text>
          </View>
        )}
      </View>

      {/* Divider */}
      <View
        style={{ backgroundColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0' }}
        className="my-3 h-px w-full"
      />

      {/* Mode Section - Simple Toggle */}
      <View className="pb-3">
        <View className="mb-3 flex-row items-center justify-between">
          <Text
            style={{
              color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)',
            }}
            className="font-roobert-medium text-sm">
            {t('models.mode', 'Mode')}
          </Text>
        </View>

        {/* Model Toggle - Basic/Advanced switcher */}
        {modelsLoading ? (
          <View className="items-center py-4">
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
          <ModelToggle
            models={models}
            selectedModelId={selectedModelId}
            onModelChange={handleModelChange}
            canAccessModel={canAccessModel}
            onUpgradeRequired={handleUpgradeRequired}
          />
        )}
      </View>

      {/* Integrations Button - Always visible */}
      <AnimatedPressable
        style={[
          integrationsAnimatedStyle,
          {
            borderColor: hasFreeTier
              ? colorScheme === 'dark'
                ? '#22c55e'
                : '#16a34a'
              : colorScheme === 'dark'
                ? '#454444'
                : '#c2c2c2',
            borderWidth: hasFreeTier ? 1.5 : 1,
            backgroundColor: hasFreeTier
              ? colorScheme === 'dark'
                ? 'rgba(34, 197, 94, 0.1)'
                : 'rgba(22, 163, 74, 0.1)'
              : 'transparent',
          },
        ]}
        className="mt-4 h-16 flex-1 flex-row items-center justify-center gap-2 rounded-2xl"
        onPress={handleIntegrationsPress}
        onPressIn={handleIntegrationsPressIn}
        onPressOut={handleIntegrationsPressOut}>
        {hasFreeTier ? (
          <Lock size={18} color={colorScheme === 'dark' ? '#22c55e' : '#16a34a'} />
        ) : (
          <AppBubble />
        )}
        <Text
          className="font-roobert-medium"
          style={{
            color: hasFreeTier
              ? colorScheme === 'dark'
                ? '#22c55e'
                : '#16a34a'
              : colorScheme === 'dark'
                ? '#f8f8f8'
                : '#121215',
          }}>
          {t('integrations.connectApps')}
        </Text>
      </AnimatedPressable>
      <View
        style={{ backgroundColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0' }}
        className="my-3 h-px w-full"
      />
      {advancedFeaturesEnabled && (
        <>
          <BottomSheetTouchable
            style={{
              marginTop: 16,
              height: 64,
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 16,
              borderColor: hasFreeTier
                ? colorScheme === 'dark'
                  ? '#22c55e'
                  : '#16a34a'
                : colorScheme === 'dark'
                  ? '#454444'
                  : '#c2c2c2',
              borderWidth: hasFreeTier ? 1.5 : 1,
              backgroundColor: hasFreeTier
                ? colorScheme === 'dark'
                  ? 'rgba(34, 197, 94, 0.1)'
                  : 'rgba(22, 163, 74, 0.1)'
                : 'transparent',
            }}
            onPress={handleIntegrationsPress}>
            {hasFreeTier ? (
              <Lock size={18} color={colorScheme === 'dark' ? '#22c55e' : '#16a34a'} />
            ) : (
              <AppBubble />
            )}
            <Text
              className="font-roobert-medium"
              style={{
                color: hasFreeTier
                  ? colorScheme === 'dark'
                    ? '#22c55e'
                    : '#16a34a'
                  : colorScheme === 'dark'
                    ? '#f8f8f8'
                    : '#121215',
              }}>
              {t('integrations.connectApps')}
            </Text>
          </BottomSheetTouchable>
          <View
            style={{ backgroundColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0' }}
            className="my-3 h-px w-full"
          />
        </>
      )}
      {advancedFeaturesEnabled && (
        <>
          <View className="pb-2">
            <View className="mb-2.5 flex-row items-center justify-between">
              <Text
                style={{
                  color:
                    colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)',
                }}
                className="font-roobert-medium text-sm">
                Worker Settings
              </Text>
            </View>
            <View className="flex-row gap-2">
              <BottomSheetTouchable
                style={{
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                  minHeight: 56,
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 16,
                }}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'instructions');
                    onClose?.();
                  }
                }}>
                <Brain size={18} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </BottomSheetTouchable>
              <BottomSheetTouchable
                style={{
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                  minHeight: 56,
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 16,
                }}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'tools');
                    onClose?.();
                  }
                }}>
                <Wrench size={18} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </BottomSheetTouchable>
              <BottomSheetTouchable
                style={{
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                  minHeight: 56,
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 16,
                }}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'integrations');
                    onClose?.();
                  }
                }}>
                <Server size={18} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </BottomSheetTouchable>
              <BottomSheetTouchable
                style={{
                  borderColor: colorScheme === 'dark' ? '#232324' : '#e0e0e0',
                  borderWidth: 1.5,
                  minHeight: 56,
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 16,
                }}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'triggers');
                    onClose?.();
                  }
                }}>
                <Zap size={18} color={colorScheme === 'dark' ? '#f8f8f8' : '#121215'} />
              </BottomSheetTouchable>
            </View>
          </View>
        </>
      )}
    </View>
  );

  const renderAgentsView = () => (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View className="mb-4 flex-row items-center">
        <BackButton onPress={() => navigateToView('main')} />
        <View className="ml-3 flex-1">
          <Text
            style={{ color: colorScheme === 'dark' ? '#f8f8f8' : '#121215' }}
            className="font-roobert-semibold text-xl">
            {t('agents.selectAgent')}
          </Text>
          <Text
            style={{
              color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)',
            }}
            className="font-roobert text-sm">
            {t('agents.chooseAgent')}
          </Text>
        </View>
      </View>

      {/* Search Bar */}
      <View className="mb-4">
        <SearchBar
          value={agentQuery}
          onChangeText={updateAgentQuery}
          placeholder={t('agents.searchAgents')}
          onClear={clearAgentSearch}
        />
      </View>

      {/* Workers List */}
      <View className="mb-3 flex-row items-center justify-between">
        <Text
          style={{
            color: colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)',
          }}
          className="font-roobert-medium text-sm">
          {t('agents.myWorkers')}
        </Text>
        {onCreateAgent && (
          <BottomSheetTouchable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              if (hasFreeTier) {
                handleUpgradeRequired();
              } else {
                onCreateAgent();
              }
            }}>
            {hasFreeTier ? (
              <Sparkles size={18} color={colorScheme === 'dark' ? '#22c55e' : '#16a34a'} />
            ) : (
              <Plus
                size={18}
                color={
                  colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'
                }
              />
            )}
          </BottomSheetTouchable>
        )}
      </View>

      <EntityList
        entities={processedAgentResults}
        isLoading={false}
        searchQuery={agentQuery}
        emptyMessage="No workers available"
        noResultsMessage="No workers found"
        gap={4}
        renderItem={(agent) => (
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
      snapPoints={['90%']}
      enablePanDownToClose
      onDismiss={handleDismiss}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{
        backgroundColor: colorScheme === 'dark' ? '#161618' : '#FFFFFF',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
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
            paddingHorizontal: 24,
            paddingTop: 24,
            paddingBottom: 48,
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
