import * as React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAgents } from '@/hooks/api/useAgents';
import type { Agent } from '@/api/types';

/**
 * Agent Context Type
 */
interface AgentContextType {
  // State
  selectedAgentId: string | undefined;
  agents: Agent[];
  isLoading: boolean;
  error: Error | null;
  hasInitialized: boolean;
  
  // Methods
  selectAgent: (agentId: string) => Promise<void>;
  loadAgents: () => Promise<void>;
  getDefaultAgent: () => Agent | null;
  getCurrentAgent: () => Agent | null;
  isSunaAgent: () => boolean;
  clearSelection: () => Promise<void>;
}

const AgentContext = React.createContext<AgentContextType | undefined>(undefined);

/**
 * Agent Provider Component
 * 
 * Wraps the app with agent state and methods
 * Manages agent selection persistence and auto-initialization
 * 
 * @example
 * <AgentProvider>
 *   <App />
 * </AgentProvider>
 */
export function AgentProvider({ children }: { children: React.ReactNode }) {
  // State
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | undefined>(undefined);
  const [hasInitialized, setHasInitialized] = React.useState(false);
  
  // API hooks
  const { data: agentsResponse, isLoading, error, refetch } = useAgents({
    limit: 100,
    sort_by: 'name',
    sort_order: 'asc'
  });
  
  const agents = agentsResponse?.agents || [];
  
  // AsyncStorage key
  const STORAGE_KEY = '@agentpress/selected_agent_id';
  
  // Load selected agent from AsyncStorage on mount
  React.useEffect(() => {
    const loadStoredAgent = async () => {
      try {
        const storedAgentId = await AsyncStorage.getItem(STORAGE_KEY);
        if (storedAgentId) {
          setSelectedAgentId(storedAgentId);
        }
      } catch (error) {
        console.error('Failed to load stored agent:', error);
      }
    };
    
    loadStoredAgent();
  }, []);
  
  // Auto-select default agent when agents are loaded
  React.useEffect(() => {
    if (agents.length > 0 && !hasInitialized) {
      const autoSelectDefaultAgent = () => {
        // If we have a stored agent ID and it exists in the agents list, use it
        if (selectedAgentId && agents.some(agent => agent.agent_id === selectedAgentId)) {
          setHasInitialized(true);
          return;
        }
        
        // Otherwise, find the Suna agent (metadata.is_suna_default) or first agent
        const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default);
        const defaultAgent = sunaAgent || agents[0];
        
        if (defaultAgent) {
          setSelectedAgentId(defaultAgent.agent_id);
          // Store the default selection
          AsyncStorage.setItem(STORAGE_KEY, defaultAgent.agent_id).catch(console.error);
        }
        
        setHasInitialized(true);
      };
      
      autoSelectDefaultAgent();
    }
  }, [agents, selectedAgentId, hasInitialized]);
  
  // Methods
  const selectAgent = React.useCallback(async (agentId: string) => {
    try {
      setSelectedAgentId(agentId);
      await AsyncStorage.setItem(STORAGE_KEY, agentId);
      console.log('🤖 Agent selected:', agentId);
    } catch (error) {
      console.error('Failed to store selected agent:', error);
    }
  }, []);
  
  const loadAgents = React.useCallback(async () => {
    try {
      await refetch();
    } catch (error) {
      console.error('Failed to load agents:', error);
    }
  }, [refetch]);
  
  const getDefaultAgent = React.useCallback((): Agent | null => {
    const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default);
    return sunaAgent || agents[0] || null;
  }, [agents]);
  
  const getCurrentAgent = React.useCallback((): Agent | null => {
    if (!selectedAgentId) return null;
    return agents.find(agent => agent.agent_id === selectedAgentId) || null;
  }, [selectedAgentId, agents]);
  
  const isSunaAgent = React.useCallback((): boolean => {
    const currentAgent = getCurrentAgent();
    return currentAgent?.metadata?.is_suna_default || false;
  }, [getCurrentAgent]);
  
  const clearSelection = React.useCallback(async () => {
    try {
      setSelectedAgentId(undefined);
      setHasInitialized(false);
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error('Failed to clear agent selection:', error);
    }
  }, []);
  
  const value: AgentContextType = {
    selectedAgentId,
    agents,
    isLoading,
    error,
    hasInitialized,
    selectAgent,
    loadAgents,
    getDefaultAgent,
    getCurrentAgent,
    isSunaAgent,
    clearSelection,
  };
  
  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
}

/**
 * Hook to use agent context
 * 
 * @example
 * const { selectedAgentId, agents, selectAgent } = useAgent();
 */
export function useAgent() {
  const context = React.useContext(AgentContext);
  
  if (context === undefined) {
    throw new Error('useAgent must be used within an AgentProvider');
  }
  
  return context;
}




