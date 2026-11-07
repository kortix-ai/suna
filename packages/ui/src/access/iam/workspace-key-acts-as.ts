/**
 * Workspace settings › API keys: who a new key acts as, and what a row offers.
 *
 * Pure so the picker rules are testable without a DOM (design.md §3.2 C4b):
 *
 *   - `me`: every member mints and revokes their own keys.
 *   - `agent` / `bot`: need `token.create` (`can_manage_principals`). An agent
 *     key needs an agent in kortix.yaml; a bot key names an existing bot or a
 *     new name (the API creates the bot with the Member role).
 */
import type { WorkspaceKey, WorkspaceKeyActsAsInput, WorkspaceKeyList, WorkspaceKeyPrincipal } from '@kortix/sdk';

/** Why a principal cannot be picked, or null when it can. */
export type ActsAsBlock = 'needs_permission' | 'no_agents' | null;

export interface ActsAsOption {
  value: WorkspaceKeyPrincipal;
  block: ActsAsBlock;
}

/** The three choices of "Acts as", each with the reason it is off (if it is). */
export function actsAsOptions(list: Pick<WorkspaceKeyList, 'can_manage_principals' | 'agents'> | null | undefined): ActsAsOption[] {
  const can = list?.can_manage_principals === true;
  return [
    { value: 'me', block: null },
    { value: 'agent', block: !can ? 'needs_permission' : (list?.agents.length ?? 0) === 0 ? 'no_agents' : null },
    { value: 'bot', block: !can ? 'needs_permission' : null },
  ];
}

/** The bot Select's sentinel for "a new bot with this name". */
export const NEW_BOT = '__new_bot__';

export interface ActsAsDraft {
  actsAs: WorkspaceKeyPrincipal;
  agent: string;
  /** A bot id, or `NEW_BOT`. */
  bot: string;
  newBotName: string;
}

/** The request field for a draft, or null while it is incomplete. */
export function actsAsInput(draft: ActsAsDraft): WorkspaceKeyActsAsInput | null {
  if (draft.actsAs === 'me') return { type: 'me' };
  if (draft.actsAs === 'agent') return draft.agent.trim() ? { type: 'agent', agent: draft.agent.trim() } : null;
  if (draft.bot === NEW_BOT) return draft.newBotName.trim() ? { type: 'bot', bot: draft.newBotName.trim() } : null;
  return draft.bot ? { type: 'bot', bot: draft.bot } : null;
}

export type KeyStatus = 'active' | 'expired' | 'revoked';

/** A key's state: revoked wins over expired. */
export function keyStatus(key: Pick<WorkspaceKey, 'status' | 'revoked_at' | 'expires_at'>, now = Date.now()): KeyStatus {
  if (key.status !== 'active' || key.revoked_at) return 'revoked';
  if (key.expires_at && Date.parse(key.expires_at) <= now) return 'expired';
  return 'active';
}

/**
 * What a row's menu offers. The caller's own key: revoke, then delete once
 * revoked. An agent or bot key: revoke for a manager. An older bot's own
 * bearer: revoke, then delete for a manager.
 */
export function keyRowAction(
  key: Pick<WorkspaceKey, 'acts_as' | 'credential' | 'status' | 'revoked_at' | 'expires_at'>,
  canManagePrincipals: boolean,
  now = Date.now(),
): 'revoke' | 'delete' | null {
  const status = keyStatus(key, now);
  const own = key.acts_as.type === 'me';
  if (!own && !canManagePrincipals) return null;
  if (status !== 'revoked') return 'revoke';
  return own || key.credential === 'service_account_bearer' ? 'delete' : null;
}

/** Active keys first, then by creation, newest first. */
export function sortKeys<T extends Pick<WorkspaceKey, 'status' | 'revoked_at' | 'expires_at' | 'created_at'>>(keys: readonly T[], now = Date.now()): T[] {
  const rank = (k: T) => (keyStatus(k, now) === 'active' ? 0 : 1);
  return [...keys].sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
}
