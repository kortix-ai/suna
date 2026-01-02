import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
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
  Settings,
  Sparkles,
} from 'lucide-react-native';
import { ConversationSection } from '@/components/menu/ConversationSection';
import { BottomNav } from '@/components/menu/BottomNav';
import { ProfileSection } from '@/components/menu/ProfileSection';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter, useFocusEffect } from 'expo-router';
import { AgentList } from '@/components/agents/AgentList';
import { useAgent } from '@/contexts/AgentContext';
import { useSearch } from '@/lib/utils/search';
import { useThreads } from '@/lib/chat';
import { useAllTriggers } from '@/lib/triggers';
import { groupThreadsByMonth } from '@/lib/utils/thread-utils';
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
        <Pressable
          onPress={handleActionPress}
          className="mt-8 flex-row items-center gap-2 rounded-full bg-primary px-6 py-3.5"
          accessibilityRole="button"
          accessibilityLabel={actionLabel}>
          <Icon as={Plus} size={18} className="text-primary-foreground" strokeWidth={2.5} />
          <Text className="font-roobert-medium text-sm text-primary-foreground">{actionLabel}</Text>
        </Pressable>
      )}
    </View>
  );
}

interface BackButtonProps {
  onPress?: () => void;
}

function BackButton({ onPress }: BackButtonProps) {
  const { t } = useLanguage();

  const handlePress = () => {
    console.log('🎯 Close button pressed');
    console.log('📱 Returning to Home');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };

  return (
    <Pressable
      onPress={handlePress}
      className="h-10 w-10 items-center justify-center rounded-full p-0"
      accessibilityRole="button"
      accessibilityLabel={t('actions.goBack')}
      accessibilityHint={t('actions.returnToHome')}>
      <Icon as={ChevronFirst} size={22} className="text-foreground" strokeWidth={2} />
    </Pressable>
  );
}

interface NewChatButtonProps {
  onPress?: () => void;
}

function NewChatButton({ onPress }: NewChatButtonProps) {
  const { t } = useLanguage();

  return (
    <Pressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress?.();
      }}
      className="h-14 w-full flex-row items-center justify-center gap-2 rounded-2xl bg-primary">
      <Icon as={Plus} size={20} strokeWidth={2} className="text-primary-foreground" />
      <Text className="font-roobert-medium text-primary-foreground">{t('menu.newChat')}</Text>
    </Pressable>
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

  const handlePress = () => {
    const action =
      activeTab === 'chats'
        ? t('menu.newChat')
        : activeTab === 'workers'
          ? t('menu.newWorker')
          : t('menu.newTrigger');
    console.log('🎯 FAB pressed:', action);
    console.log('⏰ Timestamp:', new Date().toISOString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

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
    <Pressable
      onPress={handlePress}
      style={{
        width: 60,
        height: 60,
        backgroundColor: bgColor,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
        elevation: 10,
      }}
      className={cn(
        'absolute bottom-44 right-6 items-center justify-center rounded-full',
        advancedFeaturesEnabled ? 'bottom-[230px]' : 'bottom-34'
      )}
      accessibilityRole="button"
      accessibilityLabel={getAccessibilityLabel()}>
      <Icon as={Plus} size={26} color={iconColor} strokeWidth={2.5} />
    </Pressable>
  );
}

interface MenuPageProps {
  sections?: ConversationSectionType[]; // Made optional - will use real threads
  profile: UserProfile;
  activeTab?: 'chats' | 'workers' | 'triggers';
  selectedAgentId?: string;
  activeThreadId?: string; // Currently active thread ID for highlighting
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
  activeThreadId: activeThreadIdProp,
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
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const router = useRouter();
  const { agents } = useAgent();
  const { isEnabled: advancedFeaturesEnabled } = useAdvancedFeatures();
  const insets = useSafeAreaInsets();
  const [isSettingsVisible, setIsSettingsVisible] = React.useState(false);
  const [isTriggerDrawerVisible, setIsTriggerDrawerVisible] = React.useState(false);
  const [isWorkerCreationDrawerVisible, setIsWorkerCreationDrawerVisible] = React.useState(false);

  // Debug trigger drawer visibility
  React.useEffect(() => {
    console.log('🔧 TriggerCreationDrawer visible changed to:', isTriggerDrawerVisible);
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
   * Handle profile press - Opens settings drawer
   */
  const handleProfilePress = () => {
    console.log('🎯 Opening settings drawer');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setIsSettingsVisible(true);
  };

  /**
   * Handle settings drawer close
   */
  const handleCloseSettings = () => {
    console.log('🎯 Closing settings drawer');
    setIsSettingsVisible(false);
  };

  /**
   * Handle trigger creation
   */
  const handleTriggerCreate = () => {
    console.log('🔧 Opening trigger creation drawer');
    console.log('🔧 Current isTriggerDrawerVisible:', isTriggerDrawerVisible);
    setIsTriggerDrawerVisible(true);
    console.log('🔧 Set isTriggerDrawerVisible to true');
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
    console.log('🔧 Trigger created:', triggerId);
    setIsTriggerDrawerVisible(false);
    // Refetch triggers to show the new one
    refetchTriggers();
  };

  /**
   * Handle worker creation
   */
  const handleWorkerCreate = () => {
    console.log('🤖 Opening worker creation drawer');
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
    console.log('🤖 Worker created:', workerId);
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
    console.log('🤖 Opening worker config for:', agent.agent_id);
    router.push({
      pathname: '/worker-config',
      params: { workerId: agent.agent_id },
    });
    // Keep menu drawer open - don't call onClose
    // Don't call onAgentPress here - we want to open config, not start a chat
  };

  return (
    <View
      className="flex-1 overflow-hidden rounded-r-[24px] bg-neutral-50 dark:bg-neutral-900"
      style={{
        shadowColor: '#000',
        shadowOffset: { width: -8, height: 0 },
        shadowOpacity: colorScheme === 'dark' ? 0.6 : 0.2,
        shadowRadius: 16,
        elevation: 16,
      }}>
      <SafeAreaView edges={['top']} className="flex-1">
        {/* Top Header - Profile Section */}
        <Pressable
          onPress={handleProfilePress}
          className="flex-row items-center justify-between px-5 py-5 bg-neutral-50 dark:bg-neutral-900">
          <View className="flex-row items-center gap-3 flex-1">
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
            <View className="flex-col items-start gap-1.5">
              <Text className="font-roobert-medium text-sm text-neutral-900 dark:text-neutral-50">
                {profile.name ||
                  user?.user_metadata?.full_name ||
                  user?.email?.split('@')[0] ||
                  'User'}
              </Text>
              {profile.planName ? (
                (() => {
                  const planLower = profile.planName.toLowerCase();
                  const isBasic = planLower === 'basic';
                  const isPlus = planLower === 'plus';
                  const isPro = planLower === 'pro';
                  const isUltra = planLower === 'ultra';

                  // Basic - no icon, just text
                  if (isBasic) {
                    return (
                      <View className="flex-row items-center h-6 px-2 rounded-full bg-neutral-200 dark:bg-neutral-700">
                        <Text className="text-xs font-roobert-semibold text-neutral-900 dark:text-neutral-50">
                          {profile.planName}
                        </Text>
                      </View>
                    );
                  }

                  // Pro - gradient background
                  if (isPro) {
                    return (
                      <LinearGradient
                        colors={['#FFE7CE', '#E88002']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 0, y: 1 }}
                        style={{ flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 8, gap: 4, borderRadius: 12 }}
                      >
                        <Icon as={Sparkles} size={12} className="text-neutral-900" strokeWidth={2} />
                        <Text className="text-xs font-roobert-semibold text-neutral-900">
                          {profile.planName}
                        </Text>
                      </LinearGradient>
                    );
                  }

                  // Ultra - gradient background
                  if (isUltra) {
                    return (
                      <LinearGradient
                        colors={['#23D3FF', '#FDF5E0', '#FFC78C', '#FF1B07']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 0, y: 1 }}
                        style={{ flexDirection: 'row', alignItems: 'center', height: 24, paddingHorizontal: 8, gap: 4, borderRadius: 12 }}
                      >
                        <Icon as={Sparkles} size={12} className="text-neutral-900" strokeWidth={2} />
                        <Text className="text-xs font-roobert-semibold text-neutral-900">
                          {profile.planName}
                        </Text>
                      </LinearGradient>
                    );
                  }

                  // Plus - default with neutral background
                  return (
                    <View className="flex-row items-center h-6 px-2 gap-1 rounded-full bg-neutral-200 dark:bg-neutral-700">
                      <Icon as={Sparkles} size={12} className="text-neutral-900 dark:text-neutral-50" strokeWidth={2} />
                      <Text className="text-xs font-roobert-semibold text-neutral-900 dark:text-neutral-50">
                        {profile.planName}
                      </Text>
                    </View>
                  );
                })()
              ) : null}
            </View>
          </View>
          <View className="h-12 w-12 items-center justify-center rounded-full">
            <Icon
              as={Settings}
              size={20}
              className="text-neutral-900 dark:text-neutral-50"
              strokeWidth={2}
            />
          </View>
        </Pressable>


        {/* Content Area */}
        <View className="flex-1">
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ 
              paddingTop: 0, 
              paddingBottom: 120,
              paddingHorizontal: 8,
              flexGrow: 1,
            }}
            showsVerticalScrollIndicator={false}
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
                    <View className="gap-3">
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
                            activeThreadId={activeThreadIdProp}
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
                    <AgentList
                      agents={agentResults}
                      selectedAgentId={selectedAgentId}
                      onAgentPress={handleWorkerPress}
                      showChevron={false}
                      compact={false}
                    />
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
                        console.log('🔧 Trigger selected:', selectedTrigger.name);
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
          </ScrollView>
        </View>

        {/* Sticky Bottom Bar */}
        <View
          className="absolute bottom-0 left-0 right-0 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900"
          style={{
            paddingTop: 16,
            paddingBottom: Math.max(insets.bottom, 0),
            paddingHorizontal: 20,
          }}>
          <View className="flex-row items-center gap-2">
            {/* Search Bar */}
            {activeTab === 'chats' && (
              <View className="flex-1">
                <SearchBar
                  value={chatsSearch.query}
                  onChangeText={chatsSearch.updateQuery}
                  placeholder="Search"
                  onClear={() => {
                    chatsSearch.clearSearch();
                  }}
                />
              </View>
            )}
            {activeTab === 'workers' && (
              <View className="flex-1">
                <SearchBar
                  value={workersSearch.query}
                  onChangeText={workersSearch.updateQuery}
                  placeholder="Search"
                  onClear={() => {
                    workersSearch.clearSearch();
                  }}
                />
              </View>
            )}
            {activeTab === 'triggers' && (
              <View className="flex-1">
                <SearchBar
                  value={triggersSearch.query}
                  onChangeText={triggersSearch.updateQuery}
                  placeholder="Search"
                  onClear={() => {
                    triggersSearch.clearSearch();
                  }}
                />
              </View>
            )}

            {/* New Post Button */}
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (activeTab === 'chats') onNewChat?.();
                else if (activeTab === 'workers') handleWorkerCreate();
                else if (activeTab === 'triggers') handleTriggerCreate();
              }}
              className="h-12 w-12 items-center justify-center rounded-full bg-neutral-900 dark:bg-neutral-50">
              <Icon
                as={Plus}
                size={20}
                className="text-neutral-50 dark:text-neutral-900"
                strokeWidth={2.5}
              />
            </Pressable>
          </View>

          {/* Bottom Navigation (if advanced features enabled) */}
          {advancedFeaturesEnabled && (
            <View className="mt-4">
              <BottomNav
                activeTab={activeTab}
                onChatsPress={onChatsPress}
                onWorkersPress={onWorkersPress}
                onTriggersPress={onTriggersPress}
              />
            </View>
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
