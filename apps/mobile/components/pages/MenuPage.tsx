import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming, Easing } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SearchBar } from '@/components/ui/SearchBar';
import { KortixLoader, BlurFooter } from '@/components/ui';
import {
  Search,
  Plus,
  X,
  AlertCircle,
  MessageSquare,
  Users,
  Zap,
  ArrowRightIcon,
  SettingsIcon,
  PenBox,
} from 'lucide-react-native';
import { ConversationSection } from '@/components/menu/ConversationSection';
import { BottomNav } from '@/components/menu/BottomNav';
import { ProfileSection } from '@/components/menu/ProfileSection';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter, useFocusEffect } from 'expo-router';
import { AgentList } from '@/components/agents/AgentList';
import { LibrarySection } from '@/components/agents/LibrarySection';
import { useAgent } from '@/contexts/AgentContext';
import { useSearch } from '@/lib/utils/search';
import { useThreads } from '@/lib/chat';
import { useAllTriggers } from '@/lib/triggers';
import { groupThreadsByMonth, groupAgentsByTimePeriod } from '@/lib/utils/thread-utils';
import { TriggerCreationDrawer, TriggerList } from '@/components/triggers';
import { WorkerCreationDrawer } from '@/components/workers/WorkerCreationDrawer';
import { WorkerConfigDrawer } from '@/components/workers/WorkerConfigDrawer';
import { useAdvancedFeatures } from '@/hooks';
import type {
  Conversation,
  UserProfile,
  ConversationSection as ConversationSectionType,
} from '@/components/menu/types';
import type { Agent, TriggerWithAgent } from '@/api/types';
import { ProfilePicture } from '../settings/ProfilePicture';
import { TierBadge } from '@/components/billing/TierBadge';
import { cn } from '@/lib/utils';
import { log } from '@/lib/logger';
import { getBackgroundColor } from '@agentpress/shared';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface EmptyStateProps {
  type: 'loading' | 'error' | 'no-results' | 'empty';
  icon: any;
  title: string;
  description: string;
  actionLabel?: string;
  onActionPress?: () => void;
}

function EmptyState({
  type,
  icon,
  title,
  description,
  actionLabel,
  onActionPress,
}: EmptyStateProps) {
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.96, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handleActionPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onActionPress?.();
  };

  const getColors = () => {
    switch (type) {
      case 'loading':
        return {
          iconColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
          iconBgColor: 'bg-secondary',
        };
      case 'error':
        return {
          iconColor: colorScheme === 'dark' ? '#EF4444' : '#DC2626',
          iconBgColor: 'bg-destructive/10',
        };
      case 'no-results':
        return {
          iconColor: colorScheme === 'dark' ? '#71717A' : '#A1A1AA',
          iconBgColor: 'bg-secondary',
        };
      case 'empty':
        return {
          iconColor: colorScheme === 'dark' ? '#FFFFFF' : '#000000',
          iconBgColor: 'bg-primary/10',
        };
      default:
        return {
          iconColor: colorScheme === 'dark' ? '#71717A' : '#A1A1AA',
          iconBgColor: 'bg-secondary',
        };
    }
  };

  const { iconColor, iconBgColor } = getColors();

  if (type === 'loading') {
    return (
      <View className="flex-1 items-center justify-center px-8" style={{ minHeight: 300 }}>
        <KortixLoader size="large" />
        <Text className="mt-4 text-center font-roobert text-sm text-muted-foreground">{title}</Text>
      </View>
    );
  }

  return (
    <View className="items-center justify-center px-8 py-20">
      <View className={`h-20 w-20 rounded-full ${iconBgColor} mb-6 items-center justify-center`}>
        <Icon as={icon} size={36} color={iconColor} strokeWidth={2} />
      </View>
      <Text className="mb-2 text-center font-roobert-semibold text-xl tracking-tight text-foreground">
        {title}
      </Text>
      <Text className="text-center font-roobert text-sm leading-5 text-muted-foreground">
        {description}
      </Text>
      {actionLabel && onActionPress && (
        <AnimatedPressable
          onPress={handleActionPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          style={animatedStyle}
          className="mt-8 flex-row items-center gap-2 rounded-full bg-primary px-6 py-3.5"
          accessibilityRole="button"
          accessibilityLabel={actionLabel}>
          <Icon as={Plus} size={18} className="text-primary-foreground" strokeWidth={2.5} />
          <Text className="font-roobert-medium text-sm text-primary-foreground">{actionLabel}</Text>
        </AnimatedPressable>
      )}
    </View>
  );
}




interface MenuPageProps {
  sections?: ConversationSectionType[];
  profile: UserProfile;
  activeTab?: 'chats' | 'workers' | 'triggers';
  selectedAgentId?: string;
  onNewChat?: () => void;
  onNewWorker?: () => void;
  onNewTrigger?: () => void;
  onConversationPress?: (conversation: Conversation) => void;
  onAgentPress?: (agent: Agent) => void;
  onProfilePress?: () => void;
  onChatsPress?: () => void;
  onWorkersPress?: () => void;
  onTriggersPress?: () => void;
  onClose?: () => void;
  workerConfigWorkerId?: string | null;
  workerConfigInitialView?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  onCloseWorkerConfigDrawer?: () => void;
}

export function MenuPage({
  sections: propSections,
  profile,
  activeTab = 'chats',
  selectedAgentId,
  onNewChat,
  onNewWorker,
  onNewTrigger,
  onConversationPress,
  onAgentPress,
  onProfilePress,
  onChatsPress,
  onWorkersPress,
  onTriggersPress,
  onClose,
  workerConfigWorkerId,
  workerConfigInitialView,
  onCloseWorkerConfigDrawer,
}: MenuPageProps) {
  const { t, currentLanguage } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const router = useRouter();
  const { agents } = useAgent();
  const { isEnabled: advancedFeaturesEnabled } = useAdvancedFeatures();
  const insets = useSafeAreaInsets();
  const plusButtonScale = useSharedValue(1);
  const [isTriggerDrawerVisible, setIsTriggerDrawerVisible] = React.useState(false);
  const [isWorkerCreationDrawerVisible, setIsWorkerCreationDrawerVisible] = React.useState(false);

  const handleOpenSettings = React.useCallback(() => {
    router.push('/(settings)');
  }, [router]);

  // Debug trigger drawer visibility
  React.useEffect(() => {
    log.log('🔧 TriggerCreationDrawer visible changed to:', isTriggerDrawerVisible);
  }, [isTriggerDrawerVisible]);

  const isGuest = !user;

  // Fetch real threads from backend
  const { data: threads = [], isLoading: isLoadingThreads, error: threadsError } = useThreads();

  // Transform threads to sections
  const sections = React.useMemo(() => {
    // If prop sections provided (for backwards compatibility), use those
    if (propSections && propSections.length > 0) {
      return propSections;
    }

    // Otherwise, use real threads from backend
    if (threads && Array.isArray(threads) && threads.length > 0) {
      return groupThreadsByMonth(threads);
    }

    return [];
  }, [propSections, threads]);

  // Search functionality for different tabs
  const chatsSearchFields = React.useMemo(() => ['title', 'lastMessage'], []);
  const workersSearchFields = React.useMemo(() => ['name', 'description'], []);
  const triggersSearchFields = React.useMemo(
    () => ['name', 'description', 'agent_name', 'trigger_type', 'is_active'],
    []
  );

  // Memoize conversations array to prevent infinite loops
  const conversations = React.useMemo(
    () => sections.flatMap((section) => section.conversations),
    [sections]
  );

  const chatsSearch = useSearch(conversations, chatsSearchFields);

  // Transform agents to have 'id' field for search
  const searchableAgents = React.useMemo(
    () => agents.map((agent) => ({ ...agent, id: agent.agent_id })),
    [agents]
  );
  const workersSearch = useSearch(searchableAgents, workersSearchFields);

  const agentResults = React.useMemo(
    () => workersSearch.results.map((result) => ({ ...result, agent_id: result.id })),
    [workersSearch.results]
  );

  const {
    data: triggers = [],
    isLoading: triggersLoading,
    error: triggersError,
    refetch: refetchTriggers,
  } = useAllTriggers();

  const searchableTriggers = React.useMemo(
    () => triggers.map((trigger) => ({ ...trigger, id: trigger.trigger_id })),
    [triggers]
  );
  const triggersSearch = useSearch(searchableTriggers, triggersSearchFields);

  const filteredTriggers = React.useMemo(
    () =>
      triggersSearch.isSearching
        ? triggers.filter((trigger) =>
            triggersSearch.results.some((result) => result.id === trigger.trigger_id)
          )
        : triggers,
    [triggers, triggersSearch.isSearching, triggersSearch.results]
  );

  React.useEffect(() => {
    refetchTriggers();
  }, [activeTab]);

  const plusButtonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: plusButtonScale.value }],
  }));

  const handleProfilePress = () => {
    handleOpenSettings();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const handleTriggerCreate = () => {
    log.log('🔧 Opening trigger creation drawer');
    log.log('🔧 Current isTriggerDrawerVisible:', isTriggerDrawerVisible);
    setIsTriggerDrawerVisible(true);
    log.log('🔧 Set isTriggerDrawerVisible to true');
  };

  const handleTriggerDrawerClose = () => {
    setIsTriggerDrawerVisible(false);
  };

  const handleTriggerCreated = (triggerId: string) => {
    log.log('🔧 Trigger created:', triggerId);
    setIsTriggerDrawerVisible(false);
    refetchTriggers();
  };

  const handleWorkerCreate = () => {
    log.log('🤖 Opening worker creation drawer');
    setIsWorkerCreationDrawerVisible(true);
  };

  const handleWorkerCreationDrawerClose = () => {
    setIsWorkerCreationDrawerVisible(false);
  };

  const handleWorkerCreated = (workerId: string) => {
    log.log('🤖 Worker created:', workerId);
    setIsWorkerCreationDrawerVisible(false);
    router.push({
      pathname: '/worker-config',
      params: { workerId },
    });
  };

  const handleWorkerPress = (agent: Agent) => {
    log.log('🤖 Opening worker config for:', agent.agent_id);
    router.push({
      pathname: '/worker-config',
      params: { workerId: agent.agent_id },
    });
  };

  return (
    <View className="flex-1 overflow-hidden" style={{ backgroundColor: getBackgroundColor(Platform.OS, colorScheme) }}>
        <SafeAreaView edges={['top']} className="flex-1">
        <View className="flex-1 px-6 pt-2">
          <View className="mb-4 flex-row items-center gap-3">
            <Pressable
              onPress={handleProfilePress}
              className="flex-1 flex-row items-center gap-3 rounded-2xl">
              <ProfilePicture
                imageUrl={user?.user_metadata?.avatar_url || profile?.avatar}
                size={10}
                fallbackText={
                  profile.name ||
                  user?.user_metadata?.full_name ||
                  user?.email?.split('@')[0] ||
                  'User'
                }
              />
              <View className="flex-1 flex-col items-start">
                <Text className="font-roobert-semibold text-lg text-foreground">
                  {profile.name || 'User'}
                </Text>
              </View>
            </Pressable>
            <View className="flex-row items-center gap-2">
              <Pressable
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  handleOpenSettings();
                }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                }}>
                {isLiquidGlassAvailable() ? (
                  <GlassView
                    glassEffectStyle="regular"
                    tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                    isInteractive
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRadius: 22,
                    }}>
                    <Icon as={SettingsIcon} size={22} className="text-foreground" strokeWidth={2} />
                  </GlassView>
                ) : (
                  <View
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F2F2F7',
                      borderRadius: 22,
                      borderWidth: 0.5,
                      borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
                    }}>
                    <Icon as={SettingsIcon} size={22} className="text-foreground" strokeWidth={2} />
                  </View>
                )}
              </Pressable>
              <Pressable
                onPress={() => {
                  router.back();
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                }}>
                {isLiquidGlassAvailable() ? (
                  <GlassView
                    glassEffectStyle="regular"
                    tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                    isInteractive
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      borderRadius: 22,
                    }}>
                    <Icon as={ArrowRightIcon} size={22} className="text-foreground" strokeWidth={2} />
                  </GlassView>
                ) : (
                  <View
                    style={{
                      flex: 1,
                      justifyContent: 'center',
                      alignItems: 'center',
                      backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F2F2F7',
                      borderRadius: 22,
                      borderWidth: 0.5,
                      borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
                    }}>
                    <Icon as={ArrowRightIcon} size={22} className="text-foreground" strokeWidth={2} />
                  </View>
                )}
              </Pressable>
            </View>
          </View>

          <View className="relative -mx-6 flex-1">
            <ScrollView
              className="flex-1"
              contentContainerClassName="px-6"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ 
                paddingTop: 0, 
                paddingBottom: 40,
                flexGrow: 1,
              }}>
              {activeTab === 'chats' && (
                <>
                  {isLoadingThreads ? (
                    <EmptyState
                      type="loading"
                      icon={MessageSquare}
                      title={t('loading.threads') || 'Loading chats...'}
                      description=""
                    />
                  ) : threadsError ? (
                    <EmptyState
                      type="error"
                      icon={AlertCircle}
                      title={t('errors.loadingThreads') || 'Failed to load chats'}
                      description={t('errors.tryAgain') || 'Please try again later'}
                    />
                  ) : sections.length === 0 ? (
                    <EmptyState
                      type="empty"
                      icon={MessageSquare}
                      title={t('emptyStates.noConversations') || 'No chats yet'}
                      description={
                        t('emptyStates.noConversationsDescription') ||
                        'Start a new chat to get started'
                      }
                      actionLabel={t('chat.newChat') || 'New Chat'}
                      onActionPress={onNewChat}
                    />
                  ) : (
                    <View className="gap-8">
                      {sections.map((section) => {
                        const filteredConversations = chatsSearch.isSearching
                          ? section.conversations.filter((conv) =>
                              chatsSearch.results.some((result) => result.id === conv.id)
                            )
                          : section.conversations;

                        if (filteredConversations.length === 0 && chatsSearch.isSearching) {
                          return null;
                        }

                        return (
                          <ConversationSection
                            key={section.id}
                            section={{
                              ...section,
                              conversations: filteredConversations,
                            }}
                            onConversationPress={onConversationPress}
                          />
                        );
                      })}

                      {chatsSearch.isSearching &&
                        sections.every(
                          (section) =>
                            !section.conversations.some((conv) =>
                              chatsSearch.results.some((result) => result.id === conv.id)
                            )
                        ) && (
                          <EmptyState
                            type="no-results"
                            icon={Search}
                            title={t('emptyStates.noResults') || 'No results'}
                            description={
                              t('emptyStates.tryDifferentSearch') || 'Try a different search term'
                            }
                          />
                        )}
                    </View>
                  )}
                </>
              )}

              {activeTab === 'workers' && (
                <>
                  {agentResults.length === 0 && !workersSearch.isSearching ? (
                    <EmptyState
                      type="empty"
                      icon={Users}
                      title={t('emptyStates.noWorkers') || 'No workers yet'}
                      description={
                        t('emptyStates.noWorkersDescription') ||
                        'Create your first worker to get started'
                      }
                      actionLabel={t('agents.newWorker') || 'New Worker'}
                      onActionPress={handleWorkerCreate}
                    />
                  ) : agentResults.length === 0 && workersSearch.isSearching ? (
                    <EmptyState
                      type="no-results"
                      icon={Search}
                      title={t('emptyStates.noResults') || 'No results'}
                      description={
                        t('emptyStates.tryDifferentSearch') || 'Try a different search term'
                      }
                    />
                  ) : (
                    <View className="gap-8">
                      {groupAgentsByTimePeriod(agentResults, currentLanguage).map((section) => {
                        const filteredAgents = workersSearch.isSearching
                          ? section.agents.filter((agent) =>
                              workersSearch.results.some((result) => result.id === agent.agent_id)
                            )
                          : section.agents;

                        if (filteredAgents.length === 0 && workersSearch.isSearching) {
                          return null;
                        }

                        return (
                          <LibrarySection
                            key={section.id}
                            label={section.label}
                            agents={filteredAgents}
                            selectedAgentId={selectedAgentId}
                            onAgentPress={handleWorkerPress}
                          />
                        );
                      })}
                    </View>
                  )}
                </>
              )}

              {activeTab === 'triggers' && (
                <>
                  {triggersLoading ? (
                    <EmptyState
                      type="loading"
                      icon={Zap}
                      title={t('loading.triggers') || 'Loading triggers...'}
                      description=""
                    />
                  ) : triggersError ? (
                    <EmptyState
                      type="error"
                      icon={AlertCircle}
                      title={t('errors.loadingTriggers') || 'Failed to load triggers'}
                      description={t('errors.tryAgain') || 'Please try again later'}
                    />
                  ) : filteredTriggers.length === 0 && !triggersSearch.isSearching ? (
                    <EmptyState
                      type="empty"
                      icon={Zap}
                      title={t('emptyStates.triggers') || 'No triggers yet'}
                      description={
                        t('emptyStates.triggersDescription') ||
                        'Create your first trigger to get started'
                      }
                      actionLabel={t('menu.newTrigger') || 'Create Trigger'}
                      onActionPress={handleTriggerCreate}
                    />
                  ) : filteredTriggers.length === 0 && triggersSearch.isSearching ? (
                    <EmptyState
                      type="no-results"
                      icon={Search}
                      title={t('emptyStates.noResults') || 'No results'}
                      description={
                        t('emptyStates.tryDifferentSearch') || 'Try a different search term'
                      }
                    />
                  ) : (
                    <TriggerList
                      triggers={filteredTriggers}
                      isLoading={triggersLoading}
                      error={triggersError}
                      searchQuery={triggersSearch.query}
                      onTriggerPress={(selectedTrigger) => {
                        log.log('🔧 Trigger selected:', selectedTrigger.name);
                        router.push({
                          pathname: '/trigger-detail',
                          params: { triggerId: selectedTrigger.trigger_id },
                        });
                      }}
                    />
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>

        {/* Blur gradient behind footer - positioned absolutely */}
        <BlurFooter height={140} intensity={80} />

        {/* Footer section with search and actions */}
        <View className="gap-4 px-6" style={{ paddingBottom: Math.max(insets.bottom, 16) + 16}}>
          <View className="flex-row items-center gap-3">
            <View className="flex-1">
              {activeTab === 'chats' && (
                <SearchBar
                  value={chatsSearch.query}
                  onChangeText={chatsSearch.updateQuery}
                  placeholder={t('menu.searchConversations') || 'Search chats...'}
                  onClear={chatsSearch.clearSearch}
                />
              )}
              {activeTab === 'workers' && (
                <SearchBar
                  value={workersSearch.query}
                  onChangeText={workersSearch.updateQuery}
                  placeholder={t('placeholders.searchWorkers') || 'Search workers...'}
                  onClear={workersSearch.clearSearch}
                />
              )}
              {activeTab === 'triggers' && (
                <SearchBar
                  value={triggersSearch.query}
                  onChangeText={triggersSearch.updateQuery}
                  placeholder={t('placeholders.searchTriggers') || 'Search triggers...'}
                  onClear={triggersSearch.clearSearch}
                />
              )}
            </View>
            <AnimatedPressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (activeTab === 'chats') onNewChat?.();
                else if (activeTab === 'workers') handleWorkerCreate();
                else if (activeTab === 'triggers') handleTriggerCreate();
              }}
              onPressIn={() => {
                plusButtonScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                plusButtonScale.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={[
                plusButtonAnimatedStyle,
                {
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                },
              ]}>
              {isLiquidGlassAvailable() ? (
                <GlassView
                  glassEffectStyle="regular"
                  tintColor={colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.04)'}
                  isInteractive
                  style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    borderRadius: 22,
                  }}>
                  <Icon as={PenBox} size={20} className="text-foreground" strokeWidth={2.5} />
                </GlassView>
              ) : (
                <View
                  style={{
                    flex: 1,
                    justifyContent: 'center',
                    alignItems: 'center',
                    backgroundColor: colorScheme === 'dark' ? '#2C2C2E' : '#F2F2F7',
                    borderRadius: 22,
                    borderWidth: 0.5,
                    borderColor: colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.06)',
                  }}>
                  <Icon as={PenBox} size={20} className="text-foreground" strokeWidth={2.5} />
                </View>
              )}
            </AnimatedPressable>
          </View>
          {advancedFeaturesEnabled && (
            <BottomNav
              activeTab={activeTab}
              onChatsPress={onChatsPress}
              onWorkersPress={onWorkersPress}
              onTriggersPress={onTriggersPress}
            />
          )}
        </View>
      </SafeAreaView>


      {isTriggerDrawerVisible && (
        <TriggerCreationDrawer
          visible={isTriggerDrawerVisible}
          onClose={handleTriggerDrawerClose}
          onTriggerCreated={handleTriggerCreated}
        />
      )}

      {isWorkerCreationDrawerVisible && (
        <WorkerCreationDrawer
          visible={isWorkerCreationDrawerVisible}
          onClose={handleWorkerCreationDrawerClose}
          onWorkerCreated={handleWorkerCreated}
        />
      )}

      {workerConfigWorkerId && (
        <WorkerConfigDrawer
          visible={!!workerConfigWorkerId}
          workerId={workerConfigWorkerId || null}
          initialView={workerConfigInitialView}
          onClose={onCloseWorkerConfigDrawer || (() => {})}
        />
      )}
    </View>
  );
}
