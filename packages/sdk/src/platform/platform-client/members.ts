/**
 * Platform API client — sandbox members, scopes, and legacy project ACL access.
 */

import { authenticatedFetch } from '../auth';
import type { SandboxInfo } from './types';
import { getSandboxUrl } from './urls';

// ─── Sandbox members (team access) ───────────────────────────────────────────

export type SandboxMemberRole = 'owner' | 'admin' | 'member';

export interface SandboxMember {
  user_id: string;
  email: string | null;
  role: SandboxMemberRole | null;
  added_by: string | null;
  added_at: string;
  monthly_spend_cap_cents?: number | null;
  current_period_cents?: number;
}

export interface SandboxPendingInvite {
  invite_id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface SandboxMembersResponse {
  sandbox_id: string;
  can_manage: boolean;
  viewer_user_id: string;
  members: SandboxMember[];
  pending_invites: SandboxPendingInvite[];
}

export interface AddSandboxMemberResult {
  status: 'added' | 'invited';
  user_id?: string;
  email?: string;
  role?: 'admin' | 'member';
}

export async function listSandboxMembers(sandboxId: string): Promise<SandboxMembersResponse> {
  throw new Error('Sandbox members moved to project access; use project members for project-session sandboxes');
}

export async function addSandboxMember(
  sandboxId: string,
  email: string,
  role: 'admin' | 'member' = 'member',
): Promise<AddSandboxMemberResult> {
  throw new Error('Sandbox members moved to project access; invite the user to the project instead');
}

export async function removeSandboxMember(sandboxId: string, userId: string): Promise<void> {
  throw new Error('Sandbox members moved to project access; update project access instead');
}

export async function updateSandboxMemberRole(
  sandboxId: string,
  userId: string,
  role: SandboxMemberRole,
): Promise<void> {
  throw new Error('Sandbox members moved to project access; update project access instead');
}

export async function updateSandboxMemberSpendCap(
  sandboxId: string,
  userId: string,
  capCents: number | null,
): Promise<void> {
  throw new Error('Sandbox member spend caps are not exposed for project-session sandboxes');
}

export type ScopeEffect = 'grant' | 'revoke' | null;

export interface SandboxScopeCatalogEntry {
  scope: string;
  label: string;
  description: string;
  group: string;
}

export interface SandboxMemberScopes {
  sandbox_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | null;
  inherited: string[];
  grants: string[];
  revokes: string[];
  effective: string[];
  catalog: SandboxScopeCatalogEntry[];
  groups: Record<string, string[]>;
}

export interface SandboxViewerScopes {
  sandbox_id: string;
  role: 'owner' | 'admin' | 'member' | null;
  scopes: string[];
}

export async function getViewerSandboxScopes(
  sandboxId: string,
): Promise<SandboxViewerScopes> {
  throw new Error('Sandbox scopes moved to project access for project-session sandboxes');
}

export async function getSandboxMemberScopes(
  sandboxId: string,
  userId: string,
): Promise<SandboxMemberScopes> {
  throw new Error('Sandbox scopes moved to project access for project-session sandboxes');
}

export async function updateSandboxMemberScope(
  sandboxId: string,
  userId: string,
  scope: string,
  effect: ScopeEffect,
): Promise<void> {
  throw new Error('Sandbox scopes moved to project access for project-session sandboxes');
}

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
  const res = await authenticatedFetch(`${base.replace(/\/+$/, '')}${path}`, {
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

export async function revokeSandboxInvite(sandboxId: string, inviteId: string): Promise<void> {
  throw new Error('Sandbox invites moved to project access for project-session sandboxes');
}
