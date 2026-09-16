import { PI_WORKER_SANDBOX_SLUG, isMetaAgentName } from '@kortix/shared';

export const PI_WORKER_RUNTIME_METADATA_KEYS = [
  'sandbox_slug',
  'pi_worker_boot',
  'pi_worker_ref',
  'pi_worker_sha',
  'environment_sandbox_slug',
  'runtimeArtifact',
  'agent_resources_sha',
] as const;

export interface PiWorkerRuntimeIdentity {
  ref: string;
  sha: string;
}

export const PI_WORKER_SANDBOX_PROVIDER = 'daytona' as const;

/** Keep the Pi provider constraint out of provider-neutral runtime data paths. */
export function piWorkerSandboxProviderMatches(provider: string): boolean {
  return provider === PI_WORKER_SANDBOX_PROVIDER;
}

/** True when durable metadata claims this session is a Pi runtime. */
export function sessionMetadataClaimsPiWorker(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const runtimeArtifact =
    record.runtimeArtifact &&
    typeof record.runtimeArtifact === 'object' &&
    !Array.isArray(record.runtimeArtifact)
      ? (record.runtimeArtifact as Record<string, unknown>)
      : null;
  return (
    record.sandbox_slug === PI_WORKER_SANDBOX_SLUG ||
    record.pi_worker_boot === true ||
    (Object.prototype.hasOwnProperty.call(record, 'pi_worker_ref') &&
      record.pi_worker_ref !== null) ||
    (Object.prototype.hasOwnProperty.call(record, 'pi_worker_sha') &&
      record.pi_worker_sha !== null) ||
    runtimeArtifact?.runtimeProfile === PI_WORKER_SANDBOX_SLUG ||
    runtimeArtifact?.sandboxSlug === PI_WORKER_SANDBOX_SLUG
  );
}

/** Remove runtime identity fields before caller metadata crosses the trust boundary. */
export function sanitizeCallerSessionMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const serverOwnedKeys = new Set<string>(PI_WORKER_RUNTIME_METADATA_KEYS);
  return Object.fromEntries(
    Object.entries(metadata as Record<string, unknown>).filter(
      ([key]) => !serverOwnedKeys.has(key),
    ),
  );
}

/** Read the immutable Pi artifact selector persisted by session creation. */
export function piWorkerRuntimeIdentityFromSessionMetadata(
  metadata: unknown,
): PiWorkerRuntimeIdentity | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const record = metadata as Record<string, unknown>;
  if (
    !sessionMetadataClaimsPiWorker(record) ||
    record.sandbox_slug !== PI_WORKER_SANDBOX_SLUG ||
    record.pi_worker_boot !== true ||
    typeof record.pi_worker_ref !== 'string' ||
    record.pi_worker_ref.length === 0 ||
    record.pi_worker_ref.length > 1024 ||
    /[\0\r\n]/.test(record.pi_worker_ref) ||
    typeof record.pi_worker_sha !== 'string' ||
    !/^[0-9a-f]{40}$/.test(record.pi_worker_sha)
  ) {
    return null;
  }
  return { ref: record.pi_worker_ref, sha: record.pi_worker_sha };
}

/** Read the server-owned resolved template from durable session metadata. */
export function sandboxSlugFromSessionMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).sandbox_slug;
  if (typeof value !== 'string') return undefined;
  const slug = value.trim();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug) ? slug : undefined;
}

/** Read the template selected for the Pi worker's lazy compute environment. */
export function environmentSandboxSlugFromSessionMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).environment_sandbox_slug;
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
