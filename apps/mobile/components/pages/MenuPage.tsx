import * as React from 'react';
import { Pressable, ScrollView, TextInput, View, Keyboard, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { 
  useAnimatedStyle, 
  useSharedValue, 
  withSpring,
  withTiming,
  interpolate,
  Extrapolate
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SearchBar } from '@/components/ui/SearchBar';
import { Search, Plus, X, ChevronLeft, AlertCircle } from 'lucide-react-native';
import { ConversationSection } from '@/components/menu/ConversationSection';
import { BottomNav } from '@/components/menu/BottomNav';
import { ProfileSection } from '@/components/menu/ProfileSection';
import { SettingsDrawer } from '@/components/menu/SettingsDrawer';
import { AuthDrawer } from '@/components/auth/AuthDrawer';
import { useAuthContext, useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { AgentList } from '@/components/agents/AgentList';
import { useAgent } from '@/contexts/AgentContext';
import { useSearch } from '@/lib/search';
import { useThreads, useAllTriggers } from '@/hooks/api';
import { groupThreadsByMonth } from '@/lib/thread-utils';
import { TriggerList, TriggerCreationDrawer } from '@/components/triggers';
import type { Conversation, UserProfile, ConversationSection as ConversationSectionType } from '@/components/menu/types';
import type { Agent, TriggerWithAgent } from '@/api/types';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);

/**
 * BackButton Component
 * 
 * Elegant back button to close the menu and return to home
 * Uses ChevronLeft icon from Lucide
 */
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
    console.log('🎯 Back button pressed');
    console.log('📱 Returning to Home');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress?.();
  };
  
  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={animatedStyle}
      className="w-10 h-10 items-center justify-center"
      accessibilityRole="button"
      accessibilityLabel={t('actions.goBack')}
      accessibilityHint={t('actions.returnToHome')}
    >
      <Icon 
        as={ChevronLeft}
        size={24}
        className="text-foreground"
        strokeWidth={2}
      />
    </AnimatedPressable>
  );
}


/**
 * FloatingActionButton Component
 * 
 * Elegant floating action button for creating new items
 * - Circular design: 56x56px
 * - Positioned above bottom navigation
 * - Smooth shadow and haptic feedback
 * - Context-aware (Chat/Worker/Trigger based on active tab)
 */
interface FloatingActionButtonProps {
  activeTab: 'chats' | 'workers' | 'triggers';
  onChatPress?: () => void;
  onWorkerPress?: () => void;
  onTriggerPress?: () => void;
}

function FloatingActionButton({ activeTab, onChatPress, onWorkerPress, onTriggerPress }: FloatingActionButtonProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const scale = useSharedValue(1);
  const rotate = useSharedValue(0);
  
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: scale.value },
      { rotate: `${rotate.value}deg` }
    ],
  }));
  
  const handlePressIn = () => {
    scale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
  };
  
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15, stiffness: 400 });
  };
  
  const handlePress = () => {
    const action = activeTab === 'chats' ? t('menu.newChat') : activeTab === 'workers' ? t('menu.newWorker') : t('menu.newTrigger');
    console.log('🎯 FAB pressed:', action);
    console.log('⏰ Timestamp:', new Date().toISOString());
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    
    // Rotate animation
    rotate.value = withSpring(rotate.value + 90, { damping: 15, stiffness: 400 });
    
    if (activeTab === 'chats') onChatPress?.();
    else if (activeTab === 'workers') onWorkerPress?.();
    else if (activeTab === 'triggers') onTriggerPress?.();
  };
  
  // Get accessibility label based on active tab
  const getAccessibilityLabel = () => {
    const item = activeTab === 'chats' ? 'chat' : activeTab === 'workers' ? 'worker' : 'trigger';
    return t('actions.createNew', { item });
  };
  
  // Different background colors based on theme
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
          width: 56,
          height: 56,
          backgroundColor: bgColor,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 8,
          elevation: 8,
        }
      ]}
      className="absolute bottom-44 right-6 rounded-full items-center justify-center"
      accessibilityRole="button"
      accessibilityLabel={getAccessibilityLabel()}
    >
      <Icon 
        as={Plus}
        size={28}
        color={iconColor}
        strokeWidth={2.5}
      />
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
}: MenuPageProps) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();
  const { user } = useAuthContext();
  const router = useRouter();
  const { agents } = useAgent();
  const scrollY = useSharedValue(0);
  const [isSettingsVisible, setIsSettingsVisible] = React.useState(false);
  const [isAuthDrawerVisible, setIsAuthDrawerVisible] = React.useState(false);
  const [isTriggerDrawerVisible, setIsTriggerDrawerVisible] = React.useState(false);

  // Debug trigger drawer visibility
  React.useEffect(() => {
    console.log('🔧 TriggerCreationDrawer visible changed to:', isTriggerDrawerVisible);
  }, [isTriggerDrawerVisible]);
  const authDrawerRef = React.useRef<any>(null);
  
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
  const triggersSearchFields = React.useMemo(() => ['name', 'description', 'agent_name', 'trigger_type'], []);
  
  // Memoize conversations array to prevent infinite loops
  const conversations = React.useMemo(() => 
    sections.flatMap(section => section.conversations), 
    [sections]
  );
  
  const chatsSearch = useSearch(conversations, chatsSearchFields);
  
  // Transform agents to have 'id' field for search
  const searchableAgents = React.useMemo(() => 
    agents.map(agent => ({ ...agent, id: agent.agent_id })), 
    [agents]
  );
  const workersSearch = useSearch(searchableAgents, workersSearchFields);
  
  // Transform results back to Agent type
  const agentResults = React.useMemo(() => 
    workersSearch.results.map(result => ({ ...result, agent_id: result.id })), 
    [workersSearch.results]
  );
  
  // Get triggers data
  const { data: triggers = [], isLoading: triggersLoading, error: triggersError, refetch: refetchTriggers } = useAllTriggers();
  
  // Transform triggers to have 'id' field for search
  const searchableTriggers = React.useMemo(() => 
    triggers.map(trigger => ({ ...trigger, id: trigger.trigger_id })), 
    [triggers]
  );
  const triggersSearch = useSearch(searchableTriggers, triggersSearchFields);
  
  // Transform results back to TriggerWithAgent type
  const triggerResults = React.useMemo(() => 
    triggersSearch.results.map(result => ({ ...result, trigger_id: result.id })), 
    [triggersSearch.results]
  );
  
  /**
   * Handle scroll event to track scroll position
   * Used for blur fade effect at bottom
   */
  const handleScroll = (event: any) => {
    'worklet';
    scrollY.value = event.nativeEvent.contentOffset.y;
  };
  
  /**
   * Handle profile press - Opens auth drawer if guest, otherwise settings
   */
  const handleProfilePress = () => {
    if (isGuest) {
      console.log('🎯 Opening auth drawer for guest user');
      setIsAuthDrawerVisible(true);
      authDrawerRef.current?.present();
    } else {
      console.log('🎯 Opening settings drawer');
      setIsSettingsVisible(true);
    }
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
   * Handle auth drawer close
   */
  const handleCloseAuthDrawer = () => {
    console.log('🎯 Closing auth drawer');
    setIsAuthDrawerVisible(false);
  };
  
  return (
    <View 
      className="flex-1 bg-background rounded-r-[24px] overflow-hidden"
      style={{
        shadowColor: '#000',
        shadowOffset: { width: -8, height: 0 },
        shadowOpacity: colorScheme === 'dark' ? 0.6 : 0.2,
        shadowRadius: 16,
        elevation: 16,
      }}
    >
      <SafeAreaView edges={['top', 'bottom']} className="flex-1">
        {/* Main Content Container */}
        <View className="flex-1 px-6 pt-2">
          {/* Header: Profile (80%) + Back Button (20%) */}
          <View className="flex-row items-center justify-between mb-6">
            <View className="flex-1 mr-4">
              <ProfileSection
                profile={profile}
                onPress={handleProfilePress}
              />
            </View>
            <BackButton onPress={onClose} />
          </View>
          
          {/* Search Bar - Full Width, Universal */}
          <View className="mb-6">
            <SearchBar
              value={chatsSearch.query}
              onChangeText={chatsSearch.updateQuery}
              placeholder={t('placeholders.search')}
              onClear={chatsSearch.clearSearch}
            />
          </View>
          
          {/* Scrollable Content Area with Bottom Blur */}
          <View className="flex-1 relative -mx-6">
            <AnimatedScrollView 
              className="flex-1"
              contentContainerClassName="px-6"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingTop: 0, paddingBottom: 40 }}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            >
              {activeTab === 'chats' && (
                <>
                  {isLoadingThreads ? (
                    <View className="items-center justify-center py-16">
                      <ActivityIndicator size="large" color={colorScheme === 'dark' ? '#FFFFFF' : '#000000'} />
                      <Text className="text-muted-foreground text-sm font-roobert mt-4">
                        {t('loading.threads') || 'Loading chats...'}
                      </Text>
                    </View>
                  ) : threadsError ? (
                    <View className="items-center justify-center py-16">
                      <View className="w-16 h-16 rounded-2xl bg-destructive/10 items-center justify-center mb-4">
                        <Icon 
                          as={AlertCircle}
                          size={32}
                          className="text-destructive"
                          strokeWidth={2}
                        />
                      </View>
                      <Text className="text-foreground text-lg font-roobert-semibold">
                        {t('errors.loadingThreads') || 'Failed to load chats'}
                      </Text>
                      <Text className="text-muted-foreground text-sm font-roobert mt-2 text-center px-8">
                        {t('errors.tryAgain') || 'Please try again later'}
                      </Text>
                    </View>
                  ) : sections.length === 0 ? (
                    <View className="items-center justify-center py-16">
                      <View className="w-16 h-16 rounded-2xl bg-secondary items-center justify-center mb-4">
                        <Icon 
                          as={Plus}
                          size={32}
                          className="text-muted-foreground"
                          strokeWidth={2}
                        />
                      </View>
                      <Text className="text-foreground text-lg font-roobert-semibold">
                        {t('emptyStates.chats') || 'No chats yet'}
                      </Text>
                      <Text className="text-muted-foreground text-sm font-roobert mt-2 text-center px-8">
                        {t('emptyStates.chatsDescription') || 'Start a new chat to get started'}
                      </Text>
                    </View>
                  ) : (
                    <View className="gap-8">
                      {sections.map((section) => {
                        // Filter conversations based on search results
                        const filteredConversations = chatsSearch.isSearching 
                          ? section.conversations.filter(conv => 
                              chatsSearch.results.some(result => result.id === conv.id)
                            )
                          : section.conversations;
                        
                        // Only show section if it has conversations after filtering
                        if (filteredConversations.length === 0 && chatsSearch.isSearching) {
                          return null;
                        }
                        
                        return (
                          <ConversationSection
                            key={section.id}
                            section={{
                              ...section,
                              conversations: filteredConversations
                            }}
                            onConversationPress={onConversationPress}
                          />
                        );
                      })}
                    </View>
                  )}
                </>
              )}
              
              {activeTab === 'workers' && (
                <AgentList
                  agents={agentResults}
                  selectedAgentId={selectedAgentId}
                  onAgentPress={onAgentPress}
                  showChevron={false}
                  compact={false}
                />
              )}
              
              {activeTab === 'triggers' && (
                <TriggerList
                  triggers={triggerResults}
                  onTriggerPress={(trigger) => {
                    console.log('🔧 Trigger selected:', trigger.name);
                    // Navigate to trigger detail page
                    router.push({
                      pathname: '/trigger-detail',
                      params: { triggerId: trigger.trigger_id }
                    });
                  }}
                  isLoading={triggersLoading}
                  isRefreshing={false}
                  onRefresh={refetchTriggers}
                  searchQuery={triggersSearch.query}
                  onSearchChange={triggersSearch.updateQuery}
                  showAgent={true}
                  compact={false}
                  groupByCategory={true}
                  emptyStateTitle={t('emptyStates.triggers') || 'No triggers found'}
                  emptyStateDescription={t('emptyStates.triggersDescription') || 'Create your first trigger to get started'}
                  emptyStateAction={{
                    label: t('menu.newTrigger') || 'Create Trigger',
                    onPress: handleTriggerCreate,
                  }}
                />
              )}
            </AnimatedScrollView>
            
            {/* Bottom Blur Fade Effect - Reduced height for better visibility */}
            <View 
              className="absolute bottom-0 left-0 right-0 pointer-events-none"
              style={{ height: 70 }}
            >
              <LinearGradient
                colors={
                  colorScheme === 'dark'
                    ? [
                        'rgba(18, 18, 21, 0)',
                        'rgba(18, 18, 21, 0.2)',
                        'rgba(18, 18, 21, 0.5)',
                        'rgba(18, 18, 21, 0.8)',
                        'rgba(18, 18, 21, 0.95)',
                        '#121215'
                      ]
                    : [
                        'rgba(248, 248, 248, 0)',
                        'rgba(248, 248, 248, 0.2)',
                        'rgba(248, 248, 248, 0.5)',
                        'rgba(248, 248, 248, 0.8)',
                        'rgba(248, 248, 248, 0.95)',
                        '#F8F8F8'
                      ]
                }
                locations={[0, 0.2, 0.4, 0.6, 0.8, 1]}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
        
        {/* Bottom Section: Navigation (Elegant Layout) */}
        <View className="px-6 pb-4">
          <BottomNav
            activeTab={activeTab}
            onChatsPress={onChatsPress}
            onWorkersPress={onWorkersPress}
            onTriggersPress={onTriggersPress}
          />
        </View>
      </SafeAreaView>
      
      {/* Settings Drawer */}
      <SettingsDrawer
        visible={isSettingsVisible}
        profile={profile}
        onClose={handleCloseSettings}
      />
      
      {/* Auth Drawer */}
      <AuthDrawer
        ref={authDrawerRef}
        isOpen={isAuthDrawerVisible}
        onClose={handleCloseAuthDrawer}
      />
      
      {/* Floating Action Button */}
      <FloatingActionButton
        activeTab={activeTab}
        onChatPress={onNewChat}
        onWorkerPress={onNewWorker}
        onTriggerPress={handleTriggerCreate}
      />

      {/* Trigger Creation Drawer */}
      <TriggerCreationDrawer
        visible={isTriggerDrawerVisible}
        onClose={handleTriggerDrawerClose}
        onTriggerCreated={handleTriggerCreated}
      />
    </View>
  );
}
