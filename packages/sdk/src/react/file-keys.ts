/**
 * React Query key factories for the workspace file/git caches. They live in the
 * SDK so the live event stream can invalidate them when files change; the
 * actual file-fetching hooks stay in the host app and import these keys.
 */
export const fileContentKeys = {
  all: ['opencode-files', 'content'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['opencode-files', 'content', serverUrl, filePath] as const,
};

export const fileListKeys = {
  all: ['opencode-files', 'list'] as const,
  dir: (serverUrl: string, dirPath: string) =>
    ['opencode-files', 'list', serverUrl, dirPath] as const,
};

export const gitStatusKeys = {
  all: ['opencode-files', 'git-status'] as const,
  status: (serverUrl: string) => ['opencode-files', 'git-status', serverUrl] as const,
};
