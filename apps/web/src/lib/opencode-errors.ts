export interface OpenCodeConfigIssue {
  path?: unknown[];
  message?: string;
}

export interface OpenCodeConfigInvalidError {
  name: 'ConfigInvalidError';
  data?: {
    path?: string;
    issues?: OpenCodeConfigIssue[];
  };
}

function rawErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? '');
}

export function parseOpenCodeErrorPayload(error: unknown): unknown {
  const raw = rawErrorMessage(error).trim();
  if (!raw) return null;

  const candidates = [
    raw,
    raw.replace(/^Failed to perform action:\s*/i, '').trim(),
  ];

  const objectStart = raw.indexOf('{');
  if (objectStart >= 0) candidates.push(raw.slice(objectStart));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }

  return null;
}

export function getOpenCodeConfigInvalidError(error: unknown): OpenCodeConfigInvalidError | null {
  const payload = parseOpenCodeErrorPayload(error);
  if (!payload || typeof payload !== 'object') return null;
  const maybe = payload as Partial<OpenCodeConfigInvalidError>;
  return maybe.name === 'ConfigInvalidError' ? (maybe as OpenCodeConfigInvalidError) : null;
}

export function isOpenCodeConfigInvalidError(error: unknown): boolean {
  return getOpenCodeConfigInvalidError(error) !== null;
}

export function formatOpenCodeRuntimeError(error: unknown): {
  title: string;
  message: string;
  detail?: string;
} {
  const configError = getOpenCodeConfigInvalidError(error);
  if (configError) {
    const workspacePath = configError.data?.path ?? 'OpenCode config';
    const repoPath = workspacePath.replace(/^\/workspace\//, '');
    const issue = configError.data?.issues?.[0]?.message;
    const issuePath = configError.data?.issues?.[0]?.path?.join('.');
    const permissionHint = issuePath?.startsWith('permission')
      ? 'Remove the invalid permission frontmatter entry or replace it with valid OpenCode permission config.'
      : 'Fix the invalid config entry, then restart this session.';

    return {
      title: 'OpenCode config is invalid',
      message: `${repoPath} is preventing OpenCode from loading. ${permissionHint}`,
      detail: issue ? `${issuePath ? `${issuePath}: ` : ''}${issue}` : undefined,
    };
  }

  const raw = rawErrorMessage(error);
  return {
    title: 'OpenCode failed to load',
    message: raw || 'The sandbox is running, but OpenCode returned an error.',
  };
}
