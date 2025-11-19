import * as React from 'react';
import { useAdvancedFeatures } from '@/hooks';
import { useAuthContext } from '@/contexts';
import { useSubscription, getPlanName } from '@/lib/billing';
import type { Conversation, UserProfile, ConversationSection } from '@/components/menu/types';

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
    console.log('🎯 Opening side menu');
    setIsMenuVisible(true);
  }, []);
  
  const closeMenu = React.useCallback(() => {
    console.log('🎯 Closing side menu');
    setIsMenuVisible(false);
  }, []);
  
  const toggleMenu = React.useCallback(() => {
    console.log('🎯 Toggling side menu');
    setIsMenuVisible((prev) => !prev);
  }, []);
  
  const handleNewChat = React.useCallback(() => {
    console.log('🎯 New Chat button pressed in menu');
    setSelectedConversation(null);
    onNewChat?.();
  }, [onNewChat]);
  
  const handleConversationPress = React.useCallback((conversation: Conversation) => {
    console.log('🎯 Conversation selected:', conversation.title);
    console.log('📊 Conversation data:', conversation);
    setSelectedConversation(conversation);
  }, []);
  
  const handleProfilePress = React.useCallback(() => {
    console.log('🎯 Profile pressed');
    // TODO: Open profile settings
  }, []);
  
  const handleBriefcasePress = React.useCallback(() => {
    console.log('🎯 Briefcase pressed');
    // TODO: Open briefcase view
  }, []);
  
  const handleBellPress = React.useCallback(() => {
    console.log('🎯 Notifications pressed');
    // TODO: Open notifications
  }, []);
  
  const handleStarPress = React.useCallback(() => {
    console.log('🎯 Favorites pressed');
    // TODO: Open favorites
  }, []);
  
  const handleCalendarPress = React.useCallback(() => {
    console.log('🎯 Calendar pressed');
    // TODO: Open calendar
  }, []);
  
  const handleChatsTabPress = React.useCallback(() => {
    console.log('🎯 Chats tab pressed');
    console.log('⏰ Timestamp:', new Date().toISOString());
    setActiveTab('chats');
  }, []);
  
  const handleWorkersTabPress = React.useCallback(() => {
    // Only allow tab switching if advanced features are enabled
    if (!advancedFeaturesEnabled) {
      console.log('⚠️ Workers tab disabled - advanced features not enabled');
      return;
    }
    console.log('🎯 Workers tab pressed');
    console.log('⏰ Timestamp:', new Date().toISOString());
    setActiveTab('workers');
  }, [advancedFeaturesEnabled]);
  
  const handleTriggersTabPress = React.useCallback(() => {
    // Only allow tab switching if advanced features are enabled
    if (!advancedFeaturesEnabled) {
      console.log('⚠️ Triggers tab disabled - advanced features not enabled');
      return;
    }
    console.log('🎯 Triggers tab pressed');
    console.log('⏰ Timestamp:', new Date().toISOString());
    setActiveTab('triggers');
  }, [advancedFeaturesEnabled]);
  
  // Reset to 'chats' tab when advanced features are disabled
  React.useEffect(() => {
    if (!advancedFeaturesEnabled && activeTab !== 'chats') {
      console.log('🔄 Resetting to chats tab - advanced features disabled');
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

