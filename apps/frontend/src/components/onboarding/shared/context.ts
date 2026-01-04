import { UserContext } from './types';

// Global user context - this will be replaced with proper state management
export let userContext: UserContext = {
  name: '',
  primaryGoals: [],
  selectedAgents: []
};

export const updateUserContext = (updates: Partial<UserContext>) => {
  userContext = { ...userContext, ...updates };
};

export const resetUserContext = () => {
  userContext = {
    name: '',
    primaryGoals: [],
    selectedAgents: []
  };
};

