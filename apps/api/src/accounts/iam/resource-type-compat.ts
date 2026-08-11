import { RESOURCE_TYPES, type ResourceType } from '../../iam/actions';

/**
 * Account IAM routes are shared by the canonical Workspace SDK and legacy
 * Project SDK. The authorization engine keeps its persisted `project` enum.
 * Normalize only at this HTTP boundary.
 */
export function normalizePermissionResourceType(value: unknown): ResourceType | undefined {
  if (value === 'workspace') return 'project';
  if (
    typeof value === 'string' &&
    (RESOURCE_TYPES as readonly string[]).includes(value)
  ) {
    return value as ResourceType;
  }
  return undefined;
}

/** Return the namespace used by the caller without changing engine storage. */
export function serializePermissionResourceType(
  value: string | null,
  requestedValue: unknown,
): string | null {
  return requestedValue === 'workspace' && value === 'project' ? 'workspace' : value;
}
