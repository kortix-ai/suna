/**
 * React Query key factories for the workspace file/git caches. They live in the
 * SDK so the live event stream can invalidate them when files change; the
 * actual file-fetching hooks stay in the host app and MUST build their keys
 * from these factories. A host-side copy drifts: `apps/web` once cached under
 * `runtime-files` while these said `opencode-files`, and every invalidation
 * below silently matched nothing.
 */
export const fileContentKeys = {
  all: ['runtime-files', 'content'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['runtime-files', 'content', serverUrl, filePath] as const,
};

/** Binary reads (pdf, office, media, images) served as a Blob. */
export const binaryBlobKeys = {
  all: ['runtime-files', 'binary-blob'] as const,
  file: (serverUrl: string, filePath: string) =>
    ['runtime-files', 'binary-blob', serverUrl, filePath] as const,
};

export const fileListKeys = {
  all: ['runtime-files', 'list'] as const,
  dir: (serverUrl: string, dirPath: string) =>
    ['runtime-files', 'list', serverUrl, dirPath] as const,
};

export const gitStatusKeys = {
  all: ['runtime-files', 'git-status'] as const,
  status: (serverUrl: string) => ['runtime-files', 'git-status', serverUrl] as const,
};
