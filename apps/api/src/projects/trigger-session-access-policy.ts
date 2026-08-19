import type { TriggerSessionAccess } from '@kortix/api-contract';

export const PRIVATE_TRIGGER_SESSION_ACCESS: TriggerSessionAccess = {
  mode: 'private',
  memberIds: [],
  groupIds: [],
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TriggerSessionAccessParseResult =
  | { ok: true; access: TriggerSessionAccess }
  | { ok: false; error: string };

function uniqueIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return null;
  return [...new Set(value.map((id) => id.trim()).filter(Boolean))];
}

/** Parse and normalize the account-local access policy from an untrusted request. */
export function parseTriggerSessionAccess(value: unknown): TriggerSessionAccessParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'session_access must be an object' };
  }
  const input = value as Record<string, unknown>;
  const mode = input.mode;
  if (mode !== 'private' && mode !== 'project' && mode !== 'members') {
    return {
      ok: false,
      error: 'session_access.mode must be private, members, or project',
    };
  }
  const memberIds = uniqueIds(input.memberIds);
  const groupIds = uniqueIds(input.groupIds);
  if (!memberIds || !groupIds) {
    return {
      ok: false,
      error: 'session_access memberIds and groupIds must be string arrays',
    };
  }
  const invalidId = [...memberIds, ...groupIds].find((id) => !UUID_PATTERN.test(id));
  if (invalidId) {
    return {
      ok: false,
      error: `Invalid session access principal id: ${invalidId}`,
    };
  }
  if (mode !== 'members' || memberIds.length + groupIds.length === 0) {
    return {
      ok: true,
      access:
        mode === 'members' ? PRIVATE_TRIGGER_SESSION_ACCESS : { mode, memberIds: [], groupIds: [] },
    };
  }
  return { ok: true, access: { mode, memberIds, groupIds } };
}

export function triggerSessionAccessToVisibility(
  access: TriggerSessionAccess,
): 'private' | 'project' | 'restricted' {
  return access.mode === 'members' ? 'restricted' : access.mode;
}
