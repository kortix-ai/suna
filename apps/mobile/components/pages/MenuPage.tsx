import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { SearchBar } from '@/components/ui/SearchBar';
import { KortixLoader } from '@/components/ui';
import {
  Search,
  Plus,
  X,
  AlertCircle,
  MessageSquare,
  Users,
  Zap,
  PanelLeftClose,
  CircleChevronLeft,
  ChevronLeft,
  ChevronFirst,
  ChevronsUpDown,
} from 'lucide-react-native';
import { ConversationSection } from '@/components/menu/ConversationSection';
import { BottomNav } from '@/components/menu/BottomNav';
import { ProfileSection } from '@/components/menu/ProfileSection';
import { SettingsPage } from '@/components/settings/SettingsPage';
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
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

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

interface BackButtonProps {
  onPress?: () => void;
}

function BackButton({ onPress }: BackButtonProps) {
  const { t } = useLanguage();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    log.log('🎯 Close button pressed');
    log.log('📱 Returning to Home');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="h-10 w-10 items-center justify-center rounded-full p-0"
      accessibilityRole="button"
      accessibilityLabel={t('actions.goBack')}
      accessibilityHint={t('actions.returnToHome')}>
      <Icon as={ChevronFirst} size={22} className="text-foreground" strokeWidth={2} />
    </AnimatedPressable>
  );
}

interface NewChatButtonProps {
  onPress?: () => void;
}

function NewChatButton({ onPress }: NewChatButtonProps) {
  const { t } = useLanguage();

  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      style={animatedStyle}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.();
      }}
      onPressIn={() => {
        scale.value = withSpring(0.95, { damping: 15, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 15, stiffness: 400 });
      }}
      className="h-14 w-full flex-row items-center justify-center gap-2 rounded-2xl bg-primary">
      <Icon as={Plus} size={20} strokeWidth={2} className="text-primary-foreground" />
      <Text className="font-roobert-medium text-primary-foreground">{t('menu.newChat')}</Text>
    </AnimatedPressable>
  );
}

interface FloatingActionButtonProps {
  activeTab: 'chats' | 'workers' | 'triggers';
  onChatPress?: () => void;
  onWorkerPress?: () => void;
  onTriggerPress?: () => void;
}

function FloatingActionButton({
  activeTab,
  onChatPress,
  onWorkerPress,
  onTriggerPress,
}: FloatingActionButtonProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { isEnabled: advancedFeaturesEnabled } = useAdvancedFeatures();
  const scale = useSharedValue(1);
  const rotate = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { rotate: `${rotate.value}deg` }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  const handlePress = () => {
    const action =
      activeTab === 'chats'
        ? t('menu.newChat')
        : activeTab === 'workers'
          ? t('menu.newWorker')
          : t('menu.newTrigger');
    log.log('🎯 FAB pressed:', action);
    log.log('⏰ Timestamp:', new Date().toISOString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    rotate.value = withSpring(rotate.value + 90, { damping: 15, stiffness: 400 });

    if (activeTab === 'chats') onChatPress?.();
    else if (activeTab === 'workers') onWorkerPress?.();
    else if (activeTab === 'triggers') onTriggerPress?.();
  };

  const getAccessibilityLabel = () => {
    const item = activeTab === 'chats' ? 'chat' : activeTab === 'workers' ? 'worker' : 'trigger';
    return t('actions.createNew', { item });
  };

  const bgColor = colorScheme === 'dark' ? '#FFFFFF' : '#121215';
  const iconColor = colorScheme === 'dark' ? '#121215' : '#FFFFFF';

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[
        animatedStyle,
        {
          width: 60,
          height: 60,
          backgroundColor: bgColor,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.25,
          shadowRadius: 12,
          elevation: 10,
        },
      ]}
      className={cn(
        'absolute bottom-44 right-6 items-center justify-center rounded-full',
        advancedFeaturesEnabled ? 'bottom-[230px]' : 'bottom-34'
      )}
      accessibilityRole="button"
      accessibilityLabel={getAccessibilityLabel()}>
      <Icon as={Plus} size={26} color={iconColor} strokeWidth={2.5} />
    </AnimatedPressable>
  );
}

interface MenuPageProps {
  sections?: ConversationSectionType[]; // Made optional - will use real threads
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
  // Worker config drawer props
  workerConfigWorkerId?: string | null;
  workerConfigInitialView?: 'instructions' | 'tools' | 'integrations' | 'triggers';
  onCloseWorkerConfigDrawer?: () => void;
}

/**
 * MenuPage Component
 *
 * Full-screen menu page showing conversations, navigation, and profile.
 * This is page 0 in the swipeable pager.
 *
 * Features:
 * - Search with clear button for all tabs
 * - New chat/worker/trigger buttons with haptic feedback
 * - Chats: Conversation history grouped by month
 * - Workers: AI agent list
 * - Triggers: Automation trigger list
 * - Bottom navigation tabs (Chats/Workers/Triggers)
 * - User profile section
 * - Elegant spring animations
 * - Full accessibility support
 * - Design token system for theme consistency
 *
 * Accessibility:
 * - All interactive elements have proper labels and hints
 * - Keyboard navigation support
 * - Screen reader optimized
 * - Proper hit slop for touch targets
 */
export function MenuPage({
  sections: propSections, // Renamed to avoid confusion
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
  const scrollY = useSharedValue(0);
  const profileScale = useSharedValue(1);
  const [isSettingsVisible, setIsSettingsVisible] = React.useState(false);
  const [isTriggerDrawerVisible, setIsTriggerDrawerVisible] = React.useState(false);
  const [isWorkerCreationDrawerVisible, setIsWorkerCreationDrawerVisible] = React.useState(false);

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

  // Transform results back to Agent type
  const agentResults = React.useMemo(
    () => workersSearch.results.map((result) => ({ ...result, agent_id: result.id })),
    [workersSearch.results]
  );

  // Get triggers data
  const {
    data: triggers = [],
    isLoading: triggersLoading,
    error: triggersError,
    refetch: refetchTriggers,
  } = useAllTriggers();

  // Transform triggers to have 'id' field for search (same pattern as conversations)
  const searchableTriggers = React.useMemo(
    () => triggers.map((trigger) => ({ ...trigger, id: trigger.trigger_id })),
    [triggers]
  );
  const triggersSearch = useSearch(searchableTriggers, triggersSearchFields);

  // Filter triggers based on search results (same pattern as conversations)
  const filteredTriggers = React.useMemo(
    () =>
      triggersSearch.isSearching
        ? triggers.filter((trigger) =>
            triggersSearch.results.some((result) => result.id === trigger.trigger_id)
          )
        : triggers,
    [triggers, triggersSearch.isSearching, triggersSearch.results]
  );

  // refetch the data when tab changes
  React.useEffect(() => {
    refetchTriggers();
  }, [activeTab]);

  /**
   * Handle scroll event to track scroll position
   * Used for blur fade effect at bottom
   */
  const handleScroll = (event: any) => {
    'worklet';
    scrollY.value = event.nativeEvent.contentOffset.y;
  };

  const profileAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: profileScale.value }],
  }));

  /**
   * Handle profile press - Opens settings drawer
   */
  const handleProfilePress = () => {
    log.log('🎯 Opening settings drawer');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsSettingsVisible(true);
  };

  const handleProfilePressIn = () => {
    profileScale.value = withSpring(0.97, { damping: 15, stiffness: 400 });
  };

  const handleProfilePressOut = () => {
    profileScale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };

  /**
   * Handle settings drawer close
   */
  const handleCloseSettings = () => {
    log.log('🎯 Closing settings drawer');
    setIsSettingsVisible(false);
  };

  /**
   * Handle trigger creation
   */
  const handleTriggerCreate = () => {
    log.log('🔧 Opening trigger creation drawer');
    log.log('🔧 Current isTriggerDrawerVisible:', isTriggerDrawerVisible);
    setIsTriggerDrawerVisible(true);
    log.log('🔧 Set isTriggerDrawerVisible to true');
  };

  /**
   * Handle trigger drawer close
   */
  const handleTriggerDrawerClose = () => {
    setIsTriggerDrawerVisible(false);
  };

  /**
   * Handle trigger created
   */
  const handleTriggerCreated = (triggerId: string) => {
    log.log('🔧 Trigger created:', triggerId);
    setIsTriggerDrawerVisible(false);
    // Refetch triggers to show the new one
    refetchTriggers();
  };

  /**
   * Handle worker creation
   */
  const handleWorkerCreate = () => {
    log.log('🤖 Opening worker creation drawer');
    setIsWorkerCreationDrawerVisible(true);
  };

  /**
   * Handle worker creation drawer close
   */
  const handleWorkerCreationDrawerClose = () => {
    setIsWorkerCreationDrawerVisible(false);
  };

  /**
   * Handle worker created
   */
  const handleWorkerCreated = (workerId: string) => {
    log.log('🤖 Worker created:', workerId);
    setIsWorkerCreationDrawerVisible(false);
    // Navigate to config page for the new worker
    router.push({
      pathname: '/worker-config',
      params: { workerId },
    });
  };

  /**
   * Handle worker press - navigates to config page
   */
  const handleWorkerPress = (agent: Agent) => {
    log.log('🤖 Opening worker config for:', agent.agent_id);
    router.push({
      pathname: '/worker-config',
      params: { workerId: agent.agent_id },
    });
    // Keep menu drawer open - don't call onClose
    // Don't call onAgentPress here - we want to open config, not start a chat
  };

  return (
    <View
      className="flex-1 overflow-hidden rounded-r-[24px] bg-background"
      style={{
        shadowColor: '#000',
        shadowOffset: { width: -8, height: 0 },
        shadowOpacity: colorScheme === 'dark' ? 0.6 : 0.2,
        shadowRadius: 16,
        elevation: 16,
      }}>
      <SafeAreaView edges={['top']} className="flex-1">
        <View className="flex-1 px-6 pt-2">
          <View className="mb-4 flex-row items-center gap-3">
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
                profileScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
              }}
              onPressOut={() => {
                profileScale.value = withSpring(1, { damping: 15, stiffness: 400 });
              }}
              style={profileAnimatedStyle}
              className="h-11 w-11 items-center justify-center rounded-[21px] bg-primary">
              <Icon as={Plus} size={20} className="text-primary-foreground" strokeWidth={2.5} />
            </AnimatedPressable>
          </View>

          <View className="relative -mx-6 flex-1">
            <AnimatedScrollView
              className="flex-1"
              contentContainerClassName="px-6"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ 
                paddingTop: 0, 
                paddingBottom: 40,
                flexGrow: 1,
              }}
              onScroll={handleScroll}
              scrollEventThrottle={16}>
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
                        // Filter agents in section based on search
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
                        // Navigate to trigger detail page
                        router.push({
                          pathname: '/trigger-detail',
                          params: { triggerId: selectedTrigger.trigger_id },
                        });
                      }}
                    />
                  )}
                </>
              )}
            </AnimatedScrollView>

            <View
              className="pointer-events-none absolute bottom-0 left-0 right-0"
              style={{ height: 70 }}>
              <LinearGradient
                colors={
                  colorScheme === 'dark'
                    ? [
                        'rgba(18, 18, 21, 0)',
                        'rgba(18, 18, 21, 0.2)',
                        'rgba(18, 18, 21, 0.5)',
                        'rgba(18, 18, 21, 0.8)',
                        'rgba(18, 18, 21, 0.95)',
                        '#121215',
                      ]
                    : [
                        'rgba(248, 248, 248, 0)',
                        'rgba(248, 248, 248, 0.2)',
                        'rgba(248, 248, 248, 0.5)',
                        'rgba(248, 248, 248, 0.8)',
                        'rgba(248, 248, 248, 0.95)',
                        '#F8F8F8',
                      ]
                }
                locations={[0, 0.2, 0.4, 0.6, 0.8, 1]}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>

        <View className="gap-4 px-6" style={{ paddingBottom: Math.max(insets.bottom, 16) + 16}}>
          <AnimatedPressable
            onPress={handleProfilePress}
            onPressIn={handleProfilePressIn}
            onPressOut={handleProfilePressOut}
            style={profileAnimatedStyle}
            className="flex-row items-center gap-3 rounded-2xl border border-border p-3">
            <ProfilePicture
              imageUrl={user?.user_metadata?.avatar_url || profile?.avatar}
              size={12}
              fallbackText={
                profile.name ||
                user?.user_metadata?.full_name ||
                user?.email?.split('@')[0] ||
                'User'
              }
            />
            <View className="-mt-1.5 flex-col items-start">
              <Text className="font-roobert-semibold text-lg text-foreground">
                {profile.name || 'User'}
              </Text>
              {profile.planName ? (
                <View className="flex-row items-center gap-2">
                  <TierBadge planName={profile.planName} size="sm" variant="default" />
                </View>
              ) : (
                <Text className="font-roobert text-sm text-muted-foreground">
                  {profile.email || 'Tap to open settings'}
                </Text>
              )}
            </View>
            <Icon
              as={ChevronsUpDown}
              size={20}
              className="ml-auto text-muted-foreground"
              strokeWidth={2}
            />
          </AnimatedPressable>
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

      {/* Settings Page */}
      <AnimatedPageWrapper visible={isSettingsVisible} onClose={handleCloseSettings}>
        <SettingsPage visible={isSettingsVisible} profile={profile} onClose={handleCloseSettings} />
      </AnimatedPageWrapper>

      {/* Floating Action Button */}
      {advancedFeaturesEnabled && (
        <FloatingActionButton
          activeTab={activeTab}
          onChatPress={onNewChat}
          onWorkerPress={handleWorkerCreate}
          onTriggerPress={handleTriggerCreate}
        />
      )}

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
