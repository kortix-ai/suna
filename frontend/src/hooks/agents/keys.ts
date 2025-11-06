const agentKeysBase = ['agents'] as const;

export const agentKeys = {
  all: agentKeysBase,
  lists: () => [...agentKeysBase, 'list'] as const,
  list: (filters?: Record<string, any>) => [...agentKeysBase, 'list', filters] as const,
  details: () => [...agentKeysBase, 'detail'] as const,
  detail: (id: string) => [...agentKeysBase, 'detail', id] as const,
  threadAgents: () => [...agentKeysBase, 'thread-agent'] as const,
  threadAgent: (threadId: string) => [...agentKeysBase, 'thread-agent', threadId] as const,
} as const;

export const versionKeys = {
  all: ['versions'] as const,
  lists: () => [...versionKeys.all, 'list'] as const,
  list: (agentId: string) => [...versionKeys.lists(), agentId] as const,
  details: () => [...versionKeys.all, 'detail'] as const,
  detail: (agentId: string, versionId: string) => [...versionKeys.details(), agentId, versionId] as const,
};