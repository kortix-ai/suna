import { createQueryKeys } from '@/hooks/use-query';

const sandboxKeysBase = ['sandbox'] as const;
const healthKeysBase = ['health'] as const;

export const sandboxKeys = createQueryKeys({
  all: sandboxKeysBase,
  files: (sandboxId: string, path: string) => [...sandboxKeysBase, sandboxId, 'files', path] as const,
  fileContent: (sandboxId: string, path: string) => [...sandboxKeysBase, sandboxId, 'content', path] as const,
});

export const healthKeys = createQueryKeys({
  all: healthKeysBase,
  api: () => [...healthKeysBase, 'api'] as const,
}); 