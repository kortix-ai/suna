import { useState, useCallback } from 'react';
import { Keyboard } from 'react-native';
import { useAgent } from '@/contexts/AgentContext';
import { log } from '@/lib/logger';

export type DrawerInitialView = 'main' | 'integrations';

/**
 * Custom hook for managing agent selection and operations
 * Now uses AgentContext for state management
 */
export function useAgentManager() {
  const { 
    selectedAgentId, 
    agents, 
    isLoading, 
    getCurrentAgent, 
    selectAgent 
  } = useAgent();
  
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);
  const [initialDrawerView, setInitialDrawerView] = useState<DrawerInitialView>('main');

  const openDrawer = useCallback((initialView: DrawerInitialView = 'main') => {
    log.log('🔽 [useAgentManager] Agent Selector Pressed', { initialView });
    log.log('📊 [useAgentManager] Current Agent:', { 
      id: selectedAgentId, 
      name: getCurrentAgent()?.name 
    });
    
    // Set the initial view before opening
    setInitialDrawerView(initialView);
    
    // If already visible, force a re-render by toggling
    if (isDrawerVisible) {
      log.log('⚡ [useAgentManager] Drawer already visible - force toggling');
      setIsDrawerVisible(false);
      setTimeout(() => {
        setIsDrawerVisible(true);
      }, 50);
      return;
    }
    
    log.log('👁️ [useAgentManager] Setting isDrawerVisible to TRUE');
    
    // Dismiss keyboard first for better UX
    Keyboard.dismiss();
    
    // Small delay to ensure keyboard is dismissed before opening drawer
    setTimeout(() => {
      setIsDrawerVisible(true);
    }, 150);
  }, [isDrawerVisible, selectedAgentId, getCurrentAgent]);

  const openDrawerToIntegrations = useCallback(() => {
    openDrawer('integrations');
  }, [openDrawer]);

  const closeDrawer = useCallback(() => {
    log.log('🔽 [useAgentManager] Closing drawer');
    setIsDrawerVisible(false);
    // Reset initial view to main when closing
    setInitialDrawerView('main');
  }, []);

  const selectAgentHandler = async (agentId: string) => {
    log.log('✅ Agent Changed:', {
      from: { id: selectedAgentId, name: getCurrentAgent()?.name },
      to: { id: agentId, name: agents.find(a => a.agent_id === agentId)?.name },
      timestamp: new Date().toISOString()
    });
    await selectAgent(agentId);
  };

  const openAgentSettings = () => {
    log.log('⚙️ Agent Settings Opened');
    log.log('⏰ Timestamp:', new Date().toISOString());
    // TODO: Navigate to agent settings screen or open modal
  };

  return {
    selectedAgent: getCurrentAgent(),
    isDrawerVisible,
    initialDrawerView,
    agents,
    isLoading,
    openDrawer: () => openDrawer('main'),
    openDrawerToIntegrations,
    closeDrawer,
    selectAgent: selectAgentHandler,
    openAgentSettings
  };
}

