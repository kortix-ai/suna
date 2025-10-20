import { AGENTS, DEFAULT_AGENT, type Agent } from '@/components/agents';
import { useState } from 'react';

/**
 * Custom hook for managing agent selection and operations
 */
export function useAgentManager() {
  const [selectedAgent, setSelectedAgent] = useState<Agent>(DEFAULT_AGENT);
  const [isDrawerVisible, setIsDrawerVisible] = useState(false);

  const openDrawer = () => {
    console.log('🔽 Agent Selector Pressed');
    console.log('📊 Current Agent:', { 
      id: selectedAgent.id, 
      name: selectedAgent.name 
    });
    console.log('⏰ Timestamp:', new Date().toISOString());
    setIsDrawerVisible(true);
  };

  const closeDrawer = () => {
    setIsDrawerVisible(false);
  };

  const selectAgent = (agent: Agent) => {
    console.log('✅ Agent Changed:', {
      from: { id: selectedAgent.id, name: selectedAgent.name },
      to: { id: agent.id, name: agent.name },
      timestamp: new Date().toISOString()
    });
    setSelectedAgent(agent);
  };

  const openAgentSettings = () => {
    console.log('⚙️ Agent Settings Opened');
    console.log('⏰ Timestamp:', new Date().toISOString());
    // TODO: Navigate to agent settings screen or open modal
  };

  return {
    selectedAgent,
    isDrawerVisible,
    agents: AGENTS,
    openDrawer,
    closeDrawer,
    selectAgent,
    openAgentSettings
  };
}

