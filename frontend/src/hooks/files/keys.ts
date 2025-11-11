const sandboxKeysBase = ['sandbox'] as const;
const healthKeysBase = ['health'] as const;

export const sandboxKeys = {
  all: sandboxKeysBase,
  files: (sandboxId: string, path: string) => [...sandboxKeysBase, sandboxId, 'files', path] as const,
  fileContent: (sandboxId: string, path: string) => [...sandboxKeysBase, sandboxId, 'content', path] as const,
} as const;

export const healthKeys = {
  all: healthKeysBase,
  api: () => [...healthKeysBase, 'api'] as const,
} as const; 