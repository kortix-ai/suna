import { useState } from 'react';
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
    console.log('🔽 Agent Selector Pressed');
    console.log('📊 Current Agent:', { 
      id: selectedAgentId, 
      name: getCurrentAgent()?.name 
    });
    console.log('⏰ Timestamp:', new Date().toISOString());
    setIsDrawerVisible(true);
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

