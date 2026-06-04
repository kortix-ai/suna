import * as React from 'react';
import { useAdvancedFeatures } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { useSubscription, getPlanName } from '@/lib/billing';
import type { Conversation, UserProfile, ConversationSection } from '@/components/menu/types';
import { log } from '@/lib/logger';

interface UseSideMenuProps {
  onNewChat?: () => void;
}

export function useSideMenu({ onNewChat }: UseSideMenuProps = {}) {
  const [isMenuVisible, setIsMenuVisible] = React.useState(false);
  const [selectedConversation, setSelectedConversation] = React.useState<Conversation | null>(null);
  const [activeTab, setActiveTab] = React.useState<'chats' | 'workers' | 'triggers'>('chats');
  const { isEnabled: advancedFeaturesEnabled } = useAdvancedFeatures();
  const { user } = useAuthContext();
  
  // Fetch subscription data to get plan name
  const { data: subscriptionData } = useSubscription({
    enabled: !!user,
  });

  // Get plan name from subscription data
  const planName = React.useMemo(() => {
    if (!subscriptionData) return undefined;
    return getPlanName(subscriptionData, false);
  }, [subscriptionData]);
  
  const profile: UserProfile = React.useMemo(() => ({
    id: user?.id || 'guest',
    name: user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Guest',
    email: user?.email || '',
    planName,
  }), [user, planName]); 
  
  const openMenu = React.useCallback(() => {
    log.log('🎯 Opening side menu');
    setIsMenuVisible(true);
  }, []);
  
  const closeMenu = React.useCallback(() => {
    log.log('🎯 Closing side menu');
    setIsMenuVisible(false);
  }, []);
  
  const toggleMenu = React.useCallback(() => {
    log.log('🎯 Toggling side menu');
    setIsMenuVisible((prev) => !prev);
  }, []);
  
  const handleNewChat = React.useCallback(() => {
    log.log('🎯 New Chat button pressed in menu');
    setSelectedConversation(null);
    onNewChat?.();
  }, [onNewChat]);
  
  const handleConversationPress = React.useCallback((conversation: Conversation) => {
    log.log('🎯 Conversation selected:', conversation.title);
    log.log('📊 Conversation data:', conversation);
    setSelectedConversation(conversation);
  }, []);
  
  const handleProfilePress = React.useCallback(() => {
    log.log('🎯 Profile pressed');
    // TODO: Open profile settings
  }, []);
  
  const handleBriefcasePress = React.useCallback(() => {
    log.log('🎯 Briefcase pressed');
    // TODO: Open briefcase view
  }, []);
  
  const handleBellPress = React.useCallback(() => {
    log.log('🎯 Notifications pressed');
    // TODO: Open notifications
  }, []);
  
  const handleStarPress = React.useCallback(() => {
    log.log('🎯 Favorites pressed');
    // TODO: Open favorites
  }, []);
  
  const handleCalendarPress = React.useCallback(() => {
    log.log('🎯 Calendar pressed');
    // TODO: Open calendar
  }, []);
  
  const handleChatsTabPress = React.useCallback(() => {
    log.log('🎯 Chats tab pressed');
    log.log('⏰ Timestamp:', new Date().toISOString());
    setActiveTab('chats');
  }, []);
  
  const handleWorkersTabPress = React.useCallback(() => {
    // Only allow tab switching if advanced features are enabled
    if (!advancedFeaturesEnabled) {
      log.log('⚠️ Workers tab disabled - advanced features not enabled');
      return;
    }
    log.log('🎯 Workers tab pressed');
    log.log('⏰ Timestamp:', new Date().toISOString());
    setActiveTab('workers');
  }, [advancedFeaturesEnabled]);
  
  const handleTriggersTabPress = React.useCallback(() => {
    // Only allow tab switching if advanced features are enabled
    if (!advancedFeaturesEnabled) {
      log.log('⚠️ Triggers tab disabled - advanced features not enabled');
      return;
    }
    log.log('🎯 Triggers tab pressed');
    log.log('⏰ Timestamp:', new Date().toISOString());
    setActiveTab('triggers');
  }, [advancedFeaturesEnabled]);
  
  // Reset to 'chats' tab when advanced features are disabled
  React.useEffect(() => {
    if (!advancedFeaturesEnabled && activeTab !== 'chats') {
      log.log('🔄 Resetting to chats tab - advanced features disabled');
      setActiveTab('chats');
    }
  }, [advancedFeaturesEnabled, activeTab]);
  
  // Sections now loaded directly in MenuPage via useThreads()
  const sections: ConversationSection[] = [];
  
  return {
    // State
    isMenuVisible,
    selectedConversation,
    activeTab,
    sections, // Empty - real data loaded in MenuPage
    profile,
    
    // Actions
    openMenu,
    closeMenu,
    toggleMenu,
    handleNewChat,
    handleConversationPress,
    handleProfilePress,
    handleBriefcasePress,
    handleBellPress,
    handleStarPress,
    handleCalendarPress,
    handleChatsTabPress,
    handleWorkersTabPress,
    handleTriggersTabPress,
  };
}

