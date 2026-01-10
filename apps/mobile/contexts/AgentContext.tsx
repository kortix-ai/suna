import * as React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAgents } from '@/lib/agents';
import { useAuthContext } from './AuthContext';
import type { Agent } from '@/api/types';
import { log } from '@/lib/logger';

interface AgentContextType {
  selectedAgentId: string | undefined;
  selectedModelId: string | undefined;
  agents: Agent[];
  isLoading: boolean;
  error: Error | null;
  hasInitialized: boolean;

  selectAgent: (agentId: string) => Promise<void>;
  selectModel: (modelId: string) => Promise<void>;
  loadAgents: () => Promise<void>;
  getDefaultAgent: () => Agent | null;
  getCurrentAgent: () => Agent | null;
  isSunaAgent: () => boolean;
  clearSelection: () => Promise<void>;
}

const AgentContext = React.createContext<AgentContextType | undefined>(undefined);

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const { session } = useAuthContext();

  const [selectedAgentId, setSelectedAgentId] = React.useState<string | undefined>(undefined);
  const [selectedModelId, setSelectedModelId] = React.useState<string | undefined>(undefined);
  const [hasInitialized, setHasInitialized] = React.useState(false);

  const prevSessionRef = React.useRef(session);

  const { data: agentsResponse, isLoading, error, refetch } = useAgents(
    {
      limit: 100,
      sort_by: 'name',
      sort_order: 'asc'
    },
    {
      // Only fetch if user is authenticated
      enabled: !!session,
      // Don't refetch on window focus - avoid unnecessary requests
      refetchOnWindowFocus: false,
      // Don't refetch on reconnect - we'll handle this manually
      refetchOnReconnect: false,
    }
  );

  const agents = React.useMemo(() => agentsResponse?.agents || [], [agentsResponse?.agents]);

  // Handle error state - if agents fail to load, still mark as initialized
  React.useEffect(() => {
    if (error && !hasInitialized) {
      log.error('❌ Failed to load agents, marking as initialized to unblock UI:', error);
      setHasInitialized(true);
    }
  }, [error, hasInitialized]);

  React.useEffect(() => {
    const hadSession = !!prevSessionRef.current;
    const hasSession = !!session;
    const prevUserId = prevSessionRef.current?.user?.id;
    const currentUserId = session?.user?.id;

    // Only refetch when user actually changes (login/logout/user switch)
    if ((!hadSession && hasSession) || (hadSession && hasSession && prevUserId !== currentUserId)) {
      log.log('🔄 Session changed, refetching agents...');
      setHasInitialized(false); // Reset initialization when session changes
      refetch();
    }

    prevSessionRef.current = session;
  }, [session, refetch]);

  const AGENT_STORAGE_KEY = '@selected_agent_id';
  const MODEL_STORAGE_KEY = '@selected_model_id';

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
        log.error('Failed to load stored selections:', error);
      }
    };

    loadStoredSelections();
  }, []);

  React.useEffect(() => {
    // Only auto-select if we have agents loaded and haven't initialized yet
    if (agents.length > 0 && !hasInitialized && !isLoading) {
      const autoSelectDefaultAgent = () => {
        log.log('🔄 Auto-selecting agent...', {
          selectedAgentId,
          agentsCount: agents.length,
          hasInitialized,
        });

        // If we have a stored agent ID and it exists in our agents list, we're good
        if (selectedAgentId && agents.some(agent => agent.agent_id === selectedAgentId)) {
          log.log('✅ Stored agent found in agents list:', selectedAgentId);
          setHasInitialized(true);
          return;
        }

        // No valid stored agent - select default
        const sunaAgent = agents.find(agent => agent.metadata?.is_suna_default);
        const defaultAgent = sunaAgent || agents[0];

        if (defaultAgent) {
          log.log('✅ Auto-selected default agent:', defaultAgent.name);
          setSelectedAgentId(defaultAgent.agent_id);
          AsyncStorage.setItem(AGENT_STORAGE_KEY, defaultAgent.agent_id).catch(log.error);
        }

        setHasInitialized(true);
      };

      autoSelectDefaultAgent();
    }
  }, [agents, selectedAgentId, hasInitialized, isLoading]);

  const selectAgent = React.useCallback(async (agentId: string) => {
    try {
      setSelectedAgentId(agentId);
      await AsyncStorage.setItem(AGENT_STORAGE_KEY, agentId);
      log.log('🤖 Agent selected:', agentId);
    } catch (error) {
      log.error('Failed to store selected agent:', error);
    }
  }, []);

  const selectModel = React.useCallback(async (modelId: string) => {
    try {
      setSelectedModelId(modelId);
      await AsyncStorage.setItem(MODEL_STORAGE_KEY, modelId);
      log.log('🎯 Model selected:', modelId);
    } catch (error) {
      log.error('Failed to store selected model:', error);
    }
  }, []);

  const loadAgents = React.useCallback(async () => {
    try {
      await refetch();
    } catch (error) {
      log.error('Failed to load agents:', error);
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
      log.log('🧹 Clearing agent selection...');
      setSelectedAgentId(undefined);
      setSelectedModelId(undefined);
      setHasInitialized(false);
      await Promise.all([
        AsyncStorage.removeItem(AGENT_STORAGE_KEY),
        AsyncStorage.removeItem(MODEL_STORAGE_KEY),
      ]);
    } catch (error) {
      log.error('Failed to clear selections:', error);
    }
  }, []);

  const value: AgentContextType = React.useMemo(() => ({
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
  }), [
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
  ]);

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  );
}

export function useAgent() {
  const context = React.useContext(AgentContext);

  if (context === undefined) {
    throw new Error('useAgent must be used within an AgentProvider');
  }

  return context;
}




