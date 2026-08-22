import { WORKSPACE_MODES_V2, type WorkspaceModeV2 } from '@kortix/manifest-schema';
import { isMetaAgentName } from '@kortix/shared';

/** Read the server-owned resolved template from durable session metadata. */
export function sandboxSlugFromSessionMetadata(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).sandbox_slug;
  if (typeof value !== 'string') return undefined;
  const slug = value.trim();
  return /^[a-z0-9][a-z0-9_-]{0,127}$/.test(slug) ? slug : undefined;
}

/** Read the server-owned agent workspace mode from durable session metadata. */
export function workspaceModeFromSessionMetadata(metadata: unknown): WorkspaceModeV2 | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'workspace_mode')) return undefined;
  const value = record.workspace_mode;
  return typeof value === 'string' && (WORKSPACE_MODES_V2 as readonly string[]).includes(value)
    ? (value as WorkspaceModeV2)
    : 'runtime';
}

/** Only branch and legacy sessions may receive repository bytes or credentials. */
export function workspaceModeAllowsFullRepository(
  mode: WorkspaceModeV2 | null | undefined,
): boolean {
  return mode === undefined || mode === null || mode === 'branch';
}

/** A project image contains the complete repository and is unsafe otherwise. */
export function projectImageAllowedForSession(
  agentName: string | null | undefined,
  workspaceMode: WorkspaceModeV2 | null | undefined,
): boolean {
  return !isMetaAgentName(agentName ?? '') && workspaceModeAllowsFullRepository(workspaceMode);
}

/** Apply the session sandbox precedence contract. */
export function resolveSessionSandboxSlug(input: {
  explicit?: string | null;
  agent?: string | null;
  project?: string | null;
}): string {
  return input.explicit ?? input.agent ?? input.project ?? 'default';
}
