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

  // A parked box is not a crash. The proxy answers `sandbox not ready
  // (status: stopped)` for a sandbox the control plane stopped ON PURPOSE to
  // save compute, and the conversation is intact behind it. Reserve "OpenCode
  // failed to load" for a runtime that genuinely broke.
  //
  // Matched against `raw`, not a `parseOpenCodeErrorPayload` field: `unwrap()`
  // (react/use-opencode-sessions/shared.ts) is what actually produces the
  // error this function receives for the session-list poll that drives the
  // page's runtime-error card, and it throws `new Error(body.error)` — just
  // the bare phrase, with the JSON wrapper already stripped off. There is no
  // payload left to parse by the time it gets here. The regex is exact enough
  // (`(status: stopped)` and all) that matching it against the raw string
  // cannot false-positive on an unrelated error that merely mentions "stopped".
  if (/sandbox not ready \(status: stopped\)/.test(raw)) {
    return {
      title: 'Session is waking up',
      message:
        'This session slept to save compute. Your conversation is safe — sending a message wakes it back up.',
    };
  }

  return {
    title: 'OpenCode failed to load',
    message: raw || 'The sandbox is running, but OpenCode returned an error.',
  };
}
