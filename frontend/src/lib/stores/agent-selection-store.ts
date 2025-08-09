import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Agent {
  agent_id: string;
  name: string;
  avatar?: string;
  metadata?: {
    is_suna_default?: boolean;
  };
}

interface AgentSelectionState {
  selectedAgentId: string | undefined;
  hasInitialized: boolean;
  
  setSelectedAgent: (agentId: string | undefined) => void;
  initializeFromAgents: (agents: Agent[], threadAgentId?: string) => void;
  clearSelection: () => void;
  
  getCurrentAgent: (agents: Agent[]) => Agent | null;
  isSunaAgent: (agents: Agent[]) => boolean;
}

export const useAgentSelectionStore = create<AgentSelectionState>()(
  persist(
    (set, get) => ({
      selectedAgentId: undefined,
      hasInitialized: false,

      setSelectedAgent: (agentId: string | undefined) => {
        console.log('🔄 Agent selection changed:', agentId);
        set({ selectedAgentId: agentId });
      },

      initializeFromAgents: (agents: Agent[], threadAgentId?: string) => {
        if (get().hasInitialized) return;

        if (threadAgentId) {
          console.log('🎯 Initializing with thread agent:', threadAgentId);
          set({ 
            selectedAgentId: threadAgentId, 
            hasInitialized: true 
          });
          return;
        }

        if (typeof window !== 'undefined') {
          const urlParams = new URLSearchParams(window.location.search);
          const agentIdFromUrl = urlParams.get('agent_id');
          if (agentIdFromUrl) {
            console.log('🔗 Initializing with URL agent:', agentIdFromUrl);
            set({ 
              selectedAgentId: agentIdFromUrl, 
              hasInitialized: true 
            });
            return;
          }
        }

        const current = get().selectedAgentId;
        if (current === undefined && agents.length > 0) {
          const defaultSunaAgent = agents.find(agent => agent.metadata?.is_suna_default);
          if (defaultSunaAgent) {
            console.log('🤖 Initializing with default Suna agent:', defaultSunaAgent.agent_id);
            set({ selectedAgentId: defaultSunaAgent.agent_id });
          } else if (agents.length > 0) {
            console.log('📋 Initializing with first available agent:', agents[0].agent_id);
            set({ selectedAgentId: agents[0].agent_id });
          }
        }

        set({ hasInitialized: true });
      },

      clearSelection: () => {
        set({ selectedAgentId: undefined, hasInitialized: false });
      },

      getCurrentAgent: (agents: Agent[]) => {
        const { selectedAgentId } = get();
        return selectedAgentId 
          ? agents.find(agent => agent.agent_id === selectedAgentId) || null
          : null;
      },

      isSunaAgent: (agents: Agent[]) => {
        const { selectedAgentId } = get();
        const currentAgent = selectedAgentId 
          ? agents.find(agent => agent.agent_id === selectedAgentId)
          : null;
        return currentAgent?.metadata?.is_suna_default || selectedAgentId === undefined;
      },
    }),
    {
      name: 'agent-selection-storage',
      partialize: (state) => ({ 
        selectedAgentId: state.selectedAgentId 
      }),
    }
  )
);

export const useAgentSelection = () => {
  const store = useAgentSelectionStore();
  
  return {
    selectedAgentId: store.selectedAgentId,
    hasInitialized: store.hasInitialized,
    setSelectedAgent: store.setSelectedAgent,
    initializeFromAgents: store.initializeFromAgents,
    clearSelection: store.clearSelection,
    getCurrentAgent: store.getCurrentAgent,
    isSunaAgent: store.isSunaAgent,
  };
}; 