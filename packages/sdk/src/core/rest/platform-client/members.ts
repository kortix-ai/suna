/**
 * Platform API client — the project ACL that lives INSIDE a sandbox.
 *
 * The nine `*SandboxMember*` / `*SandboxScope*` exports that used to sit above
 * this comment were deleted with the canonical-RBAC refactor. They had thrown
 * on every call since the `sandbox_members` store was retired (0 rows), and
 * were kept only so the public-surface snapshot would not move. Carrying nine
 * functions and five types that cannot succeed is worse than one breaking
 * change: it advertises a capability the platform does not have. Access to a
 * project-session sandbox is the project's own access — see
 * `createAssignment` / `listAssignments` in `projects-client/assignments.ts`.
 */

import { authenticatedFetch } from '../../http/auth';
import { stripTrailingSlashes } from '../../../platform/strings';
import type { SandboxInfo } from './types';
import { getSandboxUrl } from './urls';

// ─── Legacy project ACL inside a sandbox ─────────────────────────────────────
//
// The ACL lives in kortix-master's sqlite next to the projects it governs, so
// these helpers talk to kortix-master via the preview proxy. Emails aren't
// known inside the sandbox — hydrate them client-side by joining against the
// sandbox member list (which does carry emails).

export interface SandboxProjectMember {
  user_id: string;
  role: 'owner' | 'admin' | 'member';
  added_by: string | null;
  added_at: string;
}

export interface SandboxProjectMembersResponse {
  project_id: string;
  members: SandboxProjectMember[];
}

async function fetchKortixMaster<T>(
  sandbox: SandboxInfo,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = getSandboxUrl(sandbox);
  const res = await authenticatedFetch(`${stripTrailingSlashes(base)}${path}`, {
    signal: AbortSignal.timeout(8_000),
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function listSandboxProjectMembers(
  sandbox: SandboxInfo,
  projectId: string,
): Promise<SandboxProjectMembersResponse> {
  return fetchKortixMaster<SandboxProjectMembersResponse>(
    sandbox,
    `/kortix/projects/${encodeURIComponent(projectId)}/members`,
    { method: 'GET' },
  );
}

export async function grantSandboxProjectAccess(
  sandbox: SandboxInfo,
  projectId: string,
  userId: string,
  role: 'admin' | 'member' = 'member',
): Promise<void> {
  await fetchKortixMaster<void>(
    sandbox,
    `/kortix/projects/${encodeURIComponent(projectId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role }),
    },
  );
}

export async function revokeSandboxProjectAccess(
  sandbox: SandboxInfo,
  projectId: string,
  userId: string,
): Promise<void> {
  await fetchKortixMaster<void>(
    sandbox,
    `/kortix/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  );
}

