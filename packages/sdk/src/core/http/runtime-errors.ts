export interface RuntimeConfigIssue {
  path?: unknown[];
  message?: string;
}

export interface RuntimeConfigInvalidError {
  name: 'ConfigInvalidError';
  data?: {
    path?: string;
    issues?: RuntimeConfigIssue[];
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

export function parseRuntimeErrorPayload(error: unknown): unknown {
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

export function getRuntimeConfigInvalidError(error: unknown): RuntimeConfigInvalidError | null {
  const payload = parseRuntimeErrorPayload(error);
  if (!payload || typeof payload !== 'object') return null;
  const maybe = payload as Partial<RuntimeConfigInvalidError>;
  return maybe.name === 'ConfigInvalidError' ? (maybe as RuntimeConfigInvalidError) : null;
}

export function isRuntimeConfigInvalidError(error: unknown): boolean {
  return getRuntimeConfigInvalidError(error) !== null;
}

export function formatRuntimeError(error: unknown): {
  title: string;
  message: string;
  detail?: string;
} {
  const configError = getRuntimeConfigInvalidError(error);
  if (configError) {
    const workspacePath = configError.data?.path ?? 'Runtime config';
    const repoPath = workspacePath.replace(/^\/workspace\//, '');
    const issue = configError.data?.issues?.[0]?.message;
    const issuePath = configError.data?.issues?.[0]?.path?.join('.');
    const permissionHint = issuePath?.startsWith('permission')
      ? 'Remove the invalid permission frontmatter entry or replace it with valid Runtime permission config.'
      : 'Fix the invalid config entry, then restart this session.';

    return {
      title: 'Runtime config is invalid',
      message: `${repoPath} is preventing Runtime from loading. ${permissionHint}`,
      detail: issue ? `${issuePath ? `${issuePath}: ` : ''}${issue}` : undefined,
    };
  }

  const raw = rawErrorMessage(error);
  return {
    title: 'Runtime failed to load',
    message: raw || 'The sandbox is running, but Runtime returned an error.',
  };
}
