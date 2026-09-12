import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { SearchBar } from '@/components/kortix/SearchBar';
import { useLanguage } from '@/contexts';
import { useAgent } from '@/contexts/AgentContext';
import { useAdvancedFeatures } from '@/hooks';
import { useBillingContext } from '@/contexts/BillingContext';
import BottomSheet, { BottomSheetScrollView, BottomSheetView, BottomSheetModal, BottomSheetFlatList } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import {
  Plus,
  Zap,
  ArrowLeft,
  Brain,
  Wrench,
  Server,
  Sparkles,
  Lock,
  ChevronRight,
  Plug,
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
import { ModelToggle } from '@/components/models/ModelToggle';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { EntityList } from '@/components/shared/EntityList';
import { useSearch } from '@/lib/utils/search';
import { useAvailableModels } from '@/lib/models';
import type { Agent, Model } from '@/api/types';
import { ConnectionsPageContent } from '@/components/settings/ConnectionsPage';
import { ComposioAppsContent } from '@/components/settings/connections/ComposioAppsList';
import { ComposioAppDetailContent } from '@/components/settings/connections/ComposioAppDetail';
import { ComposioConnectorContent } from '@/components/settings/connections/ComposioConnector';
import { ComposioToolsContent } from '@/components/settings/connections/ComposioToolsSelector';
import { CustomMcpContent } from '@/components/settings/connections/CustomMcpDialog';
import { CustomMcpToolsContent } from '@/components/settings/connections/CustomMcpToolsSelector';
import { log } from '@/lib/logger';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface AgentDrawerProps {
  visible: boolean;
  onClose: () => void;
  onCreateAgent?: () => void;
  onOpenWorkerConfig?: (
    workerId: string,
    view?: 'instructions' | 'tools' | 'connections' | 'triggers'
  ) => void;
  onDismiss?: () => void;
}

type ViewState =
  | 'main'
  | 'agents'
  | 'connections'
  | 'composio'
  | 'composio-detail'
  | 'composio-connector'
  | 'customMcp'
  | 'customMcp-tools'
  | 'composio-tools';

function BackButton({ onPress }: { onPress: () => void }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  return (
    <Button variant="ghost" size="icon" onPress={onPress} className="h-8 w-8">
      <ArrowLeft size={20} color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
    </Button>
  );
}

export function AgentDrawer({
  visible,
  onClose,
  onCreateAgent,
  onOpenWorkerConfig,
  onDismiss,
}: AgentDrawerProps) {
  const sheetBg = useSheetBackground();
  const bottomSheetRef = React.useRef<BottomSheetModal>(null);
  const { colorScheme } = useColorScheme();
  const { t } = useLanguage();
  const { isEnabled: advancedFeaturesEnabled } = useAdvancedFeatures();
  const router = useRouter();
  const isDark = colorScheme === 'dark';

  // Theme colors
  const c = isDark ? THEME.dark : THEME.light;

  const {
    agents,
    selectedAgentId,
    selectedModelId,
    selectAgent,
    selectModel,
    isLoading,
    hasInitialized,
    loadAgents,
  } = useAgent();

  const { data: modelsData, isLoading: modelsLoading } = useAvailableModels();
  const { hasActiveSubscription, hasFreeTier } = useBillingContext();

  const models = modelsData?.models || [];
  const selectedAgent = agents.find((a) => a.agent_id === selectedAgentId);

  const isOpeningRef = React.useRef(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const [currentView, setCurrentView] = React.useState<ViewState>('main');
  const [selectedComposioApp, setSelectedComposioApp] = React.useState<any>(null);
  const [selectedComposioConnection, setSelectedComposioConnection] = React.useState<any>(null);
  const [customMcpConfig, setCustomMcpConfig] = React.useState<{
    serverName: string;
    url: string;
    tools: any[];
  } | null>(null);

  // Search for agents (only used in beta mode)
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
      if (!model.requires_subscription) return true;
      return hasActiveSubscription && !hasFreeTier;
    },
    [hasActiveSubscription, hasFreeTier]
  );

  const handleModelChange = React.useCallback(
    (modelId: string) => {
      log.log('🎯 Model Changed:', modelId);
      selectModel?.(modelId);
    },
    [selectModel]
  );

  const handleUpgradeRequired = React.useCallback(() => {
    log.log('🔒 Upgrade required');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    onClose?.();
    setTimeout(() => router.push('/plans'), 100);
  }, [onClose, router]);

  const handleSheetChange = React.useCallback(
    (index: number) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (index === -1) {
        isOpeningRef.current = false;
        onClose?.();
      } else if (index >= 0) {
        isOpeningRef.current = false;
      }
    },
    [onClose]
  );

  const handleDismiss = React.useCallback(() => {
    isOpeningRef.current = false;
    onClose?.();
    onDismiss?.();
  }, [onClose, onDismiss]);

  React.useEffect(() => {
    if (visible && !isOpeningRef.current) {
      isOpeningRef.current = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        isOpeningRef.current = false;
      }, 500);
      Keyboard.dismiss();
      loadAgents();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      bottomSheetRef.current?.present();
      setCurrentView('main');
    } else if (!visible) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      bottomSheetRef.current?.dismiss();
      clearAgentSearch();
    }
  }, [visible, clearAgentSearch, loadAgents]);

  const navigateToView = React.useCallback((view: ViewState) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCurrentView(view);
  }, []);

  const handleAgentPress = React.useCallback(
    async (agent: Agent) => {
      await selectAgent(agent.agent_id);
      navigateToView('main');
    },
    [selectAgent, navigateToView]
  );

  const handleConnectionsPress = React.useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (hasFreeTier) {
      handleUpgradeRequired();
      return;
    }
    if (!selectedAgent && advancedFeaturesEnabled) {
      Alert.alert('No Worker Selected', 'Please select a worker first.', [{ text: 'OK' }]);
      return;
    }
    setCurrentView('connections');
  }, [selectedAgent, hasFreeTier, handleUpgradeRequired, advancedFeaturesEnabled]);


  // ============================================================================
  // MAIN VIEW - Clean, focused on Mode selection
  // ============================================================================
  const renderMainView = () => (
    <View style={styles.mainContainer}>
      {/* Mode Section - Primary & prominent */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel} className="text-muted-foreground">
          {t('models.mode', 'Mode')}
        </Text>
        {modelsLoading ? (
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText} className="text-muted-foreground">Loading...</Text>
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

      {/* Connections */}
      <Pressable
        onPress={handleConnectionsPress}
        style={({ pressed }) => [
          styles.connectionsContainer,
          {
            backgroundColor: pressed ? c.hover : withAlpha(c.foreground, 0.02),
            borderColor: c.border,
          },
        ]}
      >
        <View style={styles.connectionsRow}>
          <View style={[styles.connectionsIcon, { backgroundColor: c.hover }]}>
            {hasFreeTier ? (
              <Lock size={18} color={c.mutedForeground} strokeWidth={2} />
            ) : (
              <Plug size={18} color={c.foreground} strokeWidth={2} />
            )}
          </View>
          <View style={styles.connectionsTextContainer}>
            <Text style={styles.connectionsTitle} className="text-foreground">
              Connect your Apps
            </Text>
            <Text style={styles.connectionsSubtitle} className="text-muted-foreground">
              {hasFreeTier ? 'Upgrade to unlock' : 'Google, Slack, GitHub & more'}
            </Text>
          </View>
          <ChevronRight size={18} color={c.mutedForeground} />
        </View>
      </Pressable>

      {/* Worker Section - ONLY visible in beta mode */}
      {advancedFeaturesEnabled && (
        <>
          <View style={[styles.divider, { backgroundColor: c.border }]} />

          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel} className="text-muted-foreground">
                {t('agents.myWorkers', 'Workers')}
              </Text>
              {onCreateAgent && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onPress={() => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    hasFreeTier ? handleUpgradeRequired() : onCreateAgent();
                  }}
                >
                  {hasFreeTier ? (
                    <Sparkles size={16} color={THEME.accent.green} />
                  ) : (
                    <Plus size={16} color={c.mutedForeground} />
                  )}
                </Button>
              )}
            </View>

            {/* Selected Worker */}
            {selectedAgent ? (
              <Pressable
                onPress={() => navigateToView('agents')}
                style={({ pressed }) => [
                  styles.workerCard,
                  {
                    backgroundColor: pressed ? c.card : 'transparent',
                    borderColor: c.border,
                  },
                ]}
              >
                <AgentAvatar agent={selectedAgent} size={40} />
                <View style={styles.workerInfo}>
                  <Text style={styles.workerName} className="text-foreground" numberOfLines={1}>
                    {selectedAgent.name}
                  </Text>
                  {selectedAgent.description && (
                    <Text style={styles.workerDesc} className="text-muted-foreground" numberOfLines={1}>
                      {selectedAgent.description}
                    </Text>
                  )}
                </View>
                <ChevronRight size={18} color={c.mutedForeground} />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => navigateToView('agents')}
                style={({ pressed }) => [
                  styles.workerCard,
                  {
                    backgroundColor: pressed ? c.card : 'transparent',
                    borderColor: c.border,
                  },
                ]}
              >
                <View style={[styles.workerPlaceholder, { backgroundColor: c.card }]}>
                  <Sparkles size={18} color={c.mutedForeground} />
                </View>
                <Text style={styles.workerPlaceholderText} className="text-muted-foreground">
                  Select a worker
                </Text>
                <ChevronRight size={18} color={c.mutedForeground} />
              </Pressable>
            )}
          </View>

          {/* Worker Quick Actions */}
          {selectedAgent && (
            <View style={styles.quickActionsContainer}>
              <Button
                variant="outline"
                className="flex-1 h-12 rounded-xl"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'instructions');
                    onClose?.();
                  }
                }}
              >
                <Brain size={18} color={c.foreground} />
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-12 rounded-xl"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'tools');
                    onClose?.();
                  }
                }}
              >
                <Wrench size={18} color={c.foreground} />
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-12 rounded-xl"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'connections');
                    onClose?.();
                  }
                }}
              >
                <Server size={18} color={c.foreground} />
              </Button>
              <Button
                variant="outline"
                className="flex-1 h-12 rounded-xl"
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  if (selectedAgentId && onOpenWorkerConfig) {
                    onOpenWorkerConfig(selectedAgentId, 'triggers');
                    onClose?.();
                  }
                }}
              >
                <Zap size={18} color={c.foreground} />
              </Button>
            </View>
          )}
        </>
      )}
    </View>
  );

  // ============================================================================
  // AGENTS VIEW - Worker selection (beta only)
  // ============================================================================
  const renderAgentsView = () => (
    <ScrollView showsVerticalScrollIndicator={false}>
      <View style={styles.viewHeader}>
        <BackButton onPress={() => navigateToView('main')} />
        <View style={styles.viewHeaderText}>
          <Text style={styles.viewTitle} className="text-foreground">
            {t('agents.selectAgent', 'Select Worker')}
          </Text>
          <Text style={styles.viewSubtitle} className="text-muted-foreground">
            {t('agents.chooseAgent', 'Choose a worker for your tasks')}
          </Text>
        </View>
      </View>

      <View style={styles.searchContainer}>
        <SearchBar
          value={agentQuery}
          onChangeText={updateAgentQuery}
          placeholder={t('agents.searchAgents', 'Search workers...')}
          onClear={clearAgentSearch}
        />
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel} className="text-muted-foreground">
          {t('agents.myWorkers', 'Workers')}
        </Text>
        {onCreateAgent && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              hasFreeTier ? handleUpgradeRequired() : onCreateAgent();
            }}
          >
            {hasFreeTier ? (
              <Sparkles size={16} color={THEME.accent.green} />
            ) : (
              <Plus size={16} color={c.mutedForeground} />
            )}
          </Button>
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
            avatar={<AgentAvatar agent={agent} size={44} />}
            title={agent.name}
            subtitle={agent.description}
            isSelected={agent.agent_id === selectedAgentId}
            onPress={() => handleAgentPress(agent)}
          />
        )}
      />
    </ScrollView>
  );

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      snapPoints={advancedFeaturesEnabled ? ['70%'] : ['50%']}
      enablePanDownToClose
      onDismiss={handleDismiss}
      onChange={handleSheetChange}
      backdropComponent={SheetBackdrop}
      backgroundStyle={{
        backgroundColor: sheetBg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      style={{
        zIndex: 50,
        elevation: Platform.OS === 'android' ? 10 : undefined,
      }}
    >
      {/* Composio views with FlatList */}
      {['composio', 'composio-detail', 'composio-connector'].includes(currentView) ? (
        currentView === 'composio' ? (
          <ComposioAppsContent
            onBack={() => setCurrentView('connections')}
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
            onComplete={() => setCurrentView('connections')}
            onNavigateToConnector={(app) => {
              setSelectedComposioApp(app);
              setCurrentView('composio-connector');
            }}
            onNavigateToTools={(app, connection) => {
              setSelectedComposioApp(app);
              setSelectedComposioConnection(connection);
              setCurrentView('composio-tools');
            }}
            noPadding={true}
            useBottomSheetFlatList={true}
          />
        ) : currentView === 'composio-connector' && selectedComposioApp && selectedAgent ? (
          <ComposioConnectorContent
            app={selectedComposioApp}
            onBack={() => setCurrentView('composio-detail')}
            onComplete={() => setCurrentView('connections')}
            onNavigateToTools={(app, connection) => {
              setSelectedComposioApp(app);
              setSelectedComposioConnection(connection);
              setCurrentView('composio-tools');
            }}
            mode="full"
            agentId={selectedAgent.agent_id}
            noPadding={true}
            useBottomSheetFlatList={true}
          />
        ) : null
      ) : ['composio-tools', 'customMcp-tools'].includes(currentView) ? (
        <BottomSheetView style={styles.toolsView}>
          {currentView === 'composio-tools' &&
            selectedComposioApp &&
            selectedComposioConnection &&
            selectedAgent && (
              <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)} style={{ flex: 1 }}>
                <ComposioToolsContent
                  app={selectedComposioApp}
                  connection={selectedComposioConnection}
                  agentId={selectedAgent.agent_id}
                  onBack={() => setCurrentView('composio-detail')}
                  onComplete={() => setCurrentView('connections')}
                  noPadding={true}
                />
              </Animated.View>
            )}
          {currentView === 'customMcp-tools' && customMcpConfig && (
            <Animated.View entering={FadeIn.duration(300)} exiting={FadeOut.duration(200)} style={{ flex: 1 }}>
              <CustomMcpToolsContent
                serverName={customMcpConfig.serverName}
                url={customMcpConfig.url}
                tools={customMcpConfig.tools}
                onBack={() => setCurrentView('customMcp')}
                onComplete={(enabledTools) => {
                  Alert.alert(
                    t('connections.customMcp.toolsConfigured'),
                    t('connections.customMcp.toolsConfiguredMessage', { count: enabledTools.length })
                  );
                  setCurrentView('connections');
                }}
                noPadding={true}
              />
            </Animated.View>
          )}
        </BottomSheetView>
      ) : (
        <BottomSheetScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {currentView === 'main' && (
            <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)}>
              {renderMainView()}
            </Animated.View>
          )}
          {currentView === 'agents' && (
            <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)}>
              {renderAgentsView()}
            </Animated.View>
          )}
          {currentView === 'connections' && (
            <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)}>
              <ConnectionsPageContent
                onBack={() => setCurrentView('main')}
                noPadding={true}
                onNavigate={(view) => setCurrentView(view as ViewState)}
                onUpgradePress={handleUpgradeRequired}
              />
            </Animated.View>
          )}
          {currentView === 'customMcp' && (
            <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(150)}>
              <CustomMcpContent
                onBack={() => setCurrentView('connections')}
                noPadding={true}
                onSave={(config) => {
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

const styles = {
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 48,
  },
  mainContainer: {
    gap: 24,
  },
  section: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontFamily: 'Roobert-Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  loadingContainer: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  loadingText: {
    fontSize: 14,
    fontFamily: 'Roobert',
  },
  divider: {
    height: 1,
    marginVertical: 4,
  },
  connectionsContainer: {
    borderRadius: 14,
    borderWidth: 1,
  },
  connectionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  connectionsIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  connectionsTextContainer: {
    flex: 1,
    gap: 2,
  },
  connectionsTitle: {
    fontSize: 15,
    fontFamily: 'Roobert-Medium',
  },
  connectionsSubtitle: {
    fontSize: 12,
    fontFamily: 'Roobert',
  },
  workerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  workerInfo: {
    flex: 1,
    gap: 2,
  },
  workerName: {
    fontSize: 15,
    fontFamily: 'Roobert-Medium',
  },
  workerDesc: {
    fontSize: 13,
    fontFamily: 'Roobert',
  },
  workerPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workerPlaceholderText: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'Roobert',
  },
  quickActionsContainer: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  viewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    gap: 12,
  },
  viewHeaderText: {
    flex: 1,
  },
  viewTitle: {
    fontSize: 20,
    fontFamily: 'Roobert-SemiBold',
  },
  viewSubtitle: {
    fontSize: 14,
    fontFamily: 'Roobert',
    marginTop: 2,
  },
  searchContainer: {
    marginBottom: 16,
  },
  toolsView: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 32,
    flex: 1,
  },
} as const;
