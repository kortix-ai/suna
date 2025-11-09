import * as React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAgents } from '@/lib/agents';
import { useAuthContext } from './AuthContext';
import type { Agent } from '@/api/types';

/**
 * Agent Context Type
 */
interface AgentContextType {
  // State
  selectedAgentId: string | undefined;
  selectedModelId: string | undefined;
  agents: Agent[];
  isLoading: boolean;
  error: Error | null;
  hasInitialized: boolean;
  
  // Methods
  selectAgent: (agentId: string) => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
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
  // Auth state
  const { session } = useAuthContext();
  
  // State
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | undefined>(undefined);
  const [selectedModelId, setSelectedModelId] = React.useState<string | undefined>(undefined);
  const [hasInitialized, setHasInitialized] = React.useState(false);
  
  // Track previous session state to detect auth changes
  const prevSessionRef = React.useRef(session);
  
  // API hooks - only fetch when user is authenticated
  const { data: agentsResponse, isLoading, error, refetch } = useAgents(
    {
      limit: 100,
      sort_by: 'name',
      sort_order: 'asc'
    },
    {
      enabled: !!session, // Only fetch when authenticated
    }
  );
  
  const agents = agentsResponse?.agents || [];
  
  // Refetch agents when session changes (e.g., after signup or subscription completion)
  React.useEffect(() => {
    const hadSession = !!prevSessionRef.current;
    const hasSession = !!session;
    
    // If we just got a session (signup or login), refetch agents
    if (!hadSession && hasSession) {
      console.log('🔄 Session established, refetching agents...');
      refetch();
    }
    
    // If session user ID changed (switched accounts), refetch agents
    if (hadSession && hasSession && prevSessionRef.current?.user?.id !== session?.user?.id) {
      console.log('🔄 Session user changed, refetching agents...');
      refetch();
    }
    
    prevSessionRef.current = session;
  }, [session, refetch]);
  
  // Log state changes for debugging
  React.useEffect(() => {
    console.log('🤖 AgentContext State:', {
      isAuthenticated: !!session,
      hasSession: !!session,
      sessionUserId: session?.user?.id,
      isLoading,
      error: error?.message,
      agentsCount: agents.length,
      selectedAgentId,
      selectedModelId,
      hasInitialized,
      agentsResponse: agentsResponse ? 'present' : 'null'
    });
  }, [session, isLoading, error, agents.length, selectedAgentId, selectedModelId, hasInitialized, agentsResponse]);
  
  // AsyncStorage keys
  const AGENT_STORAGE_KEY = '@selected_agent_id';
  const MODEL_STORAGE_KEY = '@selected_model_id';
  
  // Load selected agent and model from AsyncStorage on mount
  React.useEffect(() => {
    const loadStoredSelections = async () => {
      try {
        const [storedAgentId, storedModelId] = await Promise.all([
          AsyncStorage.getItem(AGENT_STORAGE_KEY),
          AsyncStorage.getItem(MODEL_STORAGE_KEY),
        ]);
        
        if (storedAgentId) {
          setSelectedAgentId(storedAgentId);
        }
        if (storedModelId) {
          setSelectedModelId(storedModelId);
        }
      } catch (error) {
        console.error('Failed to load stored selections:', error);
      }
    };
    
    loadStoredSelections();
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
          AsyncStorage.setItem(AGENT_STORAGE_KEY, defaultAgent.agent_id).catch(console.error);
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
      await AsyncStorage.setItem(AGENT_STORAGE_KEY, agentId);
      console.log('🤖 Agent selected:', agentId);
    } catch (error) {
      console.error('Failed to store selected agent:', error);
    }
  }, []);
  
  const selectModel = React.useCallback(async (modelId: string) => {
    try {
      setSelectedModelId(modelId);
      await AsyncStorage.setItem(MODEL_STORAGE_KEY, modelId);
      console.log('🎯 Model selected:', modelId);
    } catch (error) {
      console.error('Failed to store selected model:', error);
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
      setSelectedModelId(undefined);
      setHasInitialized(false);
      await Promise.all([
        AsyncStorage.removeItem(AGENT_STORAGE_KEY),
        AsyncStorage.removeItem(MODEL_STORAGE_KEY),
      ]);
    } catch (error) {
      console.error('Failed to clear selections:', error);
    }
  }, []);
  
  const value: AgentContextType = {
    selectedAgentId,
    selectedModelId,
    agents,
    isLoading,
    error,
    hasInitialized,
    selectAgent,
    selectModel,
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




