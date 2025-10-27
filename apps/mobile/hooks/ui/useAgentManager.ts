import { useState } from 'react';
import { Keyboard } from 'react-native';
import { useAgent } from '@/contexts/AgentContext';

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

  const openDrawer = () => {
    console.log('🔽 [useAgentManager] Agent Selector Pressed');
    console.log('📊 [useAgentManager] Current Agent:', { 
      id: selectedAgentId, 
      name: getCurrentAgent()?.name 
    });
    console.log('⏰ [useAgentManager] Timestamp:', new Date().toISOString());
    console.log('👁️ [useAgentManager] Setting isDrawerVisible to TRUE');
    
    // Dismiss keyboard first for better UX
    Keyboard.dismiss();
    
    // Small delay to ensure keyboard is dismissed before opening drawer
    setTimeout(() => {
      setIsDrawerVisible(true);
    }, 150);
  };

  const closeDrawer = () => {
    setIsDrawerVisible(false);
  };

  const selectAgentHandler = async (agentId: string) => {
    console.log('✅ Agent Changed:', {
      from: { id: selectedAgentId, name: getCurrentAgent()?.name },
      to: { id: agentId, name: agents.find(a => a.agent_id === agentId)?.name },
      timestamp: new Date().toISOString()
    });
    await selectAgent(agentId);
  };

  const openAgentSettings = () => {
    console.log('⚙️ Agent Settings Opened');
    console.log('⏰ Timestamp:', new Date().toISOString());
    // TODO: Navigate to agent settings screen or open modal
  };

  return {
    selectedAgent: getCurrentAgent(),
    isDrawerVisible,
    agents,
    isLoading,
    openDrawer,
    closeDrawer,
    selectAgent: selectAgentHandler,
    openAgentSettings
  };
}

