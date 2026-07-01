import type { ConnectorSharing } from '@/lib/projects-client';

/**
 * Pure sharing-selection logic, shared by the <SharingPicker> component and its
 * callers (secrets, connectors, session sharing). Kept framework-free so it can
 * be unit-tested without pulling in React. The selection carries BOTH members
 * and departments (account groups) — aligned with the IAM member+department
 * model; the share-scope backend already evaluates group grants.
 */
export type SharingMode = 'project' | 'private' | 'members';

export interface SharingSelection {
  mode: SharingMode;
  memberIds: string[];
  /** Departments (account groups) allowed to use this. */
  groupIds: string[];
}

export interface OptionCopy {
  label: string;
  desc: string;
}

export interface SharingCopy {
  heading: string;
  project: OptionCopy;
  private: OptionCopy;
  members: OptionCopy;
}

export const DEFAULT_COPY: SharingCopy = {
  heading: 'Who can access this',
  project: { label: 'Project-wide', desc: 'Every member of this project' },
  private: { label: 'Only me', desc: 'Just you' },
  members: {
    label: 'Specific members or departments',
    desc: 'A chosen list of members and departments',
  },
};

/** A "Specific members or departments" selection must name at least one subject,
 *  else the empty allow-list silently collapses to project-wide on save. */
export function isSharingComplete(s: SharingSelection): boolean {
  return s.mode !== 'members' || s.memberIds.length + s.groupIds.length > 0;
}

export function selectionToIntent(s: SharingSelection): ConnectorSharing {
  if (s.mode === 'project') return { mode: 'project' };
  if (s.mode === 'private') return { mode: 'private', ownerId: '' };
  return { mode: 'members', memberIds: s.memberIds, groupIds: s.groupIds };
}

export function intentToSelection(intent: ConnectorSharing | null | undefined): SharingSelection {
  if (!intent || intent.mode === 'project') return { mode: 'project', memberIds: [], groupIds: [] };
  if (intent.mode === 'private') return { mode: 'private', memberIds: [], groupIds: [] };
  return { mode: 'members', memberIds: intent.memberIds ?? [], groupIds: intent.groupIds ?? [] };
}
