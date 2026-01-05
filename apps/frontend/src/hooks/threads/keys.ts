export const threadKeys = {
  all: ['threads'] as const,
  lists: () => ['threads', 'list'] as const,
  details: (threadId: string) => ['thread', threadId] as const,
  messages: (threadId: string) => ['thread', threadId, 'messages'] as const,
  project: (projectId: string) => ['project', projectId] as const,
  projects: () => ['projects', 'list'] as const, // For useProjects hook
  publicProjects: () => ['public-projects'] as const,
  agentRuns: (threadId: string) => ['thread', threadId, 'agent-runs'] as const,
  byProject: (projectId: string) => ['project', projectId, 'threads'] as const,
} as const;

// Project keys (consolidated from sidebar/keys.ts)
export const projectKeys = {
  all: ['projects'] as const,
  lists: () => ['projects', 'list'] as const,
  details: (projectId: string) => ['projects', 'detail', projectId] as const,
  public: () => ['projects', 'public'] as const,
} as const;