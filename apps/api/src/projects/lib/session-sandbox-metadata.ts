import { isMetaAgentName } from '@kortix/shared';

/** Read the server-owned resolved template from durable session metadata. */
export function sandboxSlugFromSessionMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).sandbox_slug;
  if (typeof value !== 'string') return undefined;
  const slug = value.trim();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug) ? slug : undefined;
}

/** Read the immutable repository policy. Legacy restrictions always remain restrictive. */
export function repositoryAccessFromSessionMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return true;
  const record = metadata as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'repository_access') && record.repository_access !== true) {
    return false;
  }
  // Keep this fallback until every old session and API replica has migrated.
  return !Object.prototype.hasOwnProperty.call(record, 'workspace_mode') || record.workspace_mode === 'branch';
}

/** Project images contain repository bytes and require repository access. */
export function projectImageAllowedForSession(
  agentName: string | null | undefined,
  repositoryAccess: boolean = true,
): boolean {
  return !isMetaAgentName(agentName ?? '') && repositoryAccess;
}

/** Apply the session sandbox precedence contract. */
export function resolveSessionSandboxSlug(input: {
  explicit?: string | null;
  agent?: string | null;
  project?: string | null;
}): string {
  return input.explicit ?? input.agent ?? input.project ?? 'default';
}
