import { createQueryKeys } from "@/hooks/use-query";

const agentKeysBase = ['agents'] as const;

export const agentKeys = createQueryKeys({
  all: agentKeysBase,
  lists: () => [...agentKeysBase, 'list'] as const,
  list: (filters?: Record<string, any>) => [...agentKeysBase, 'list', filters] as const,
  details: () => [...agentKeysBase, 'detail'] as const,
  detail: (id: string) => [...agentKeysBase, 'detail', id] as const,
  threadAgents: () => [...agentKeysBase, 'thread-agent'] as const,
  threadAgent: (threadId: string) => [...agentKeysBase, 'thread-agent', threadId] as const,
});