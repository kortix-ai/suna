import { createQueryKeys } from "@/hooks/use-query";

const projectKeysBase = ['projects'] as const;
const threadKeysBase = ['threads'] as const;

export const projectKeys = createQueryKeys({
  all: projectKeysBase,
  lists: () => [...projectKeysBase, 'list'] as const,
  details: (projectId: string) => [...projectKeysBase, 'detail', projectId] as const,
  public: () => [...projectKeysBase, 'public'] as const,
});

export const threadKeys = createQueryKeys({
  all: threadKeysBase,
  lists: () => [...threadKeysBase, 'list'] as const,
  byProject: (projectId: string) => [...threadKeysBase, 'by-project', projectId] as const,
});