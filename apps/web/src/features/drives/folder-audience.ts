/**
 * Who can open one folder of Files, as the three choices the access dialog
 * offers, and what Save writes to get there. Pure, so the mapping from the
 * choice to folder grants is tested without a server.
 *
 * The choices map onto the drives API's folder grants (people, teams, agents
 * and the project as principals; `read` < `write` < `manage`):
 *
 * - **Everyone in the project**: a grant to the project on this folder.
 * - **Admins only** (in a person's own folder: **only them**): no grant of this
 *   folder's own. Project admins manage every folder but people's own by
 *   their role; nobody else, and no session, gets it.
 * - **Specific people, teams or agents**: one grant each. A grant to an agent
 *   mounts the folder in every session of that agent.
 *
 * Grants inherit down the tree and only add: a folder cannot take away what a
 * folder above it gives. Those grants are shown, never edited here.
 */
import type { FolderGrant, FolderLevel } from '@kortix/sdk';

export type FolderAudienceMode = 'everyone' | 'restricted' | 'specific';

/** One named principal on the folder: a person, a team, or an agent (by name). */
export interface NamedAccess {
  type: 'user' | 'group' | 'agent';
  /** A user or team id; for an agent, its name (what the share API takes). */
  id: string;
  label: string;
  level: FolderLevel;
  /** Set when the grant already exists on this folder. */
  grantId?: string;
}

export interface FolderAudience {
  mode: FolderAudienceMode;
  everyoneLevel: FolderLevel;
  /** This folder's own grant to everyone in the project. */
  everyoneGrant: FolderGrant | null;
  /** This folder's own grants to people, teams and agents. */
  named: NamedAccess[];
  /** Grants made on folders above, nearest first. */
  inherited: FolderGrant[];
  /** A grant to everyone made above: the folder cannot be narrowed here. */
  inheritedEveryone: FolderGrant | null;
  /** The person whose own folder this is (or lies in), when it is one. */
  owner: FolderGrant | null;
}

export interface FolderAccessDraft {
  mode: FolderAudienceMode;
  everyoneLevel: FolderLevel;
  named: NamedAccess[];
}

export interface FolderAccessPlan {
  put: Array<{ principalType: 'project' | 'user' | 'group' | 'agent'; principalId?: string; level: FolderLevel }>;
  remove: string[];
}

const ownerGrant = (g: FolderGrant) => g.system && g.principalType === 'user' && g.level === 'manage';

export function namedKey(n: Pick<NamedAccess, 'type' | 'id'>): string {
  return `${n.type}:${n.id}`;
}

export function folderAudience(grants: readonly FolderGrant[]): FolderAudience {
  const own = grants.filter((g) => !g.inherited);
  const inherited = grants.filter((g) => g.inherited);
  const everyone = own.find((g) => g.principalType === 'project') ?? null;
  const named: NamedAccess[] = own
    .filter((g) => g.principalType !== 'project' && !ownerGrant(g))
    .map((g) => ({
      type: g.principalType as NamedAccess['type'],
      // The share API names an agent by its name, which is the grant's label.
      id: g.principalType === 'agent' ? g.label : g.principalId,
      label: g.label,
      level: g.level,
      grantId: g.grantId,
    }));
  return {
    mode: everyone ? 'everyone' : named.length > 0 ? 'specific' : 'restricted',
    everyoneLevel: everyone?.level ?? 'write',
    everyoneGrant: everyone,
    named,
    inherited,
    inheritedEveryone: inherited.find((g) => g.principalType === 'project') ?? null,
    owner: grants.find(ownerGrant) ?? null,
  };
}

/**
 * What Save writes to take the folder from `current` to `draft`. Grants are
 * written before any is removed; every write is checked by the server.
 */
export function planFolderAccess(current: FolderAudience, draft: FolderAccessDraft): FolderAccessPlan {
  const put: FolderAccessPlan['put'] = [];
  const remove: string[] = [];
  const everyone = current.everyoneGrant;

  if (draft.mode === 'everyone') {
    if (!everyone || everyone.level !== draft.everyoneLevel) put.push({ principalType: 'project', level: draft.everyoneLevel });
  } else if (everyone) {
    remove.push(everyone.grantId);
  }

  // Admins only: nobody named keeps a grant of this folder's own.
  const wanted = draft.mode === 'restricted' ? [] : draft.named;
  const before = new Map(current.named.map((n) => [namedKey(n), n]));
  const after = new Map(wanted.map((n) => [namedKey(n), n]));
  for (const [key, n] of after) {
    const was = before.get(key);
    if (!was || was.level !== n.level) put.push({ principalType: n.type, principalId: n.id, level: n.level });
  }
  for (const [key, n] of before) if (!after.has(key) && n.grantId) remove.push(n.grantId);
  return { put, remove };
}
