export const knowledgeBaseKeys = {
    all: ['knowledge-base'] as const,
    threads: () => [...knowledgeBaseKeys.all, 'threads'] as const,
    thread: (threadId: string) => [...knowledgeBaseKeys.threads(), threadId] as const,
    agents: () => [...knowledgeBaseKeys.all, 'agents'] as const,
    agent: (agentId: string) => [...knowledgeBaseKeys.agents(), agentId] as const,
    entry: (entryId: string) => [...knowledgeBaseKeys.all, 'entry', entryId] as const,
    context: (threadId: string) => [...knowledgeBaseKeys.all, 'context', threadId] as const,
    agentContext: (agentId: string) => [...knowledgeBaseKeys.all, 'agent-context', agentId] as const,
    processingJobs: (agentId: string) => [...knowledgeBaseKeys.all, 'processing-jobs', agentId] as const,
  };