import type { WorkspaceConnectorSharing } from '@kortix/sdk';

/**
 * Pure sharing-selection logic, shared by the <SharingPicker> component and its
 * callers (secrets, connectors, session sharing). Kept framework-free so it can
 * be unit-tested without pulling in React. The selection carries BOTH members
 * and groups (account groups) — aligned with the IAM member+group
 * model; the share-scope backend already evaluates group grants.
 */
export type SharingMode = 'workspace' | 'private' | 'members';

export interface SharingSelection {
  mode: SharingMode;
  memberIds: string[];
  /** Groups (account groups) allowed to use this. */
  groupIds: string[];
}

export interface OptionCopy {
  label: string;
  desc: string;
}

export interface SharingCopy {
  heading: string;
  workspace: OptionCopy;
  private: OptionCopy;
  members: OptionCopy;
}

export const DEFAULT_COPY: SharingCopy = {
  heading: 'Who can access this',
  workspace: { label: 'Workspace-wide', desc: 'Every member of this workspace' },
  private: { label: 'Only me', desc: 'Just you' },
  members: {
    label: 'Specific members or groups',
    desc: 'A chosen list of members and groups',
  },
};

/** A "Specific members or groups" selection must name at least one subject,
 *  else the empty allow-list silently collapses to workspace-wide on save. */
export function isSharingComplete(s: SharingSelection): boolean {
  return s.mode !== 'members' || s.memberIds.length + s.groupIds.length > 0;
}

export function selectionToIntent(s: SharingSelection): WorkspaceConnectorSharing {
  if (s.mode === 'workspace') return { mode: 'workspace' };
  if (s.mode === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds, groupIds: s.groupIds };
}

export function intentToSelection(intent: WorkspaceConnectorSharing | null | undefined): SharingSelection {
  if (!intent || intent.mode === 'workspace') return { mode: 'workspace', memberIds: [], groupIds: [] };
  if (intent.mode === 'private') return { mode: 'private', memberIds: [], groupIds: [] };
  return { mode: 'members', memberIds: intent.memberIds ?? [], groupIds: intent.groupIds ?? [] };
}
