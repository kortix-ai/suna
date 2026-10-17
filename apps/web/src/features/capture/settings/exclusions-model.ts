import {
  CAPTURE_EXCLUSION_GROUPS,
  type CaptureExclusionGroup,
  type CapturePolicy,
} from '@kortix/sdk';

import groupsCopy from './exclusion-groups.json';

/**
 * The model behind the organization's Exclusions (account settings ▸ Kortix
 * Capture): the mandatory lists an admin edits in the policy. A person's own
 * exclusions live in the Kortix Capture app on their computer.
 */
export type ExclusionTab = 'apps' | 'websites';
/** One edit: an app (bundle id), a website (domain), a category, or private browsing, on or off. */
export type ExclusionChange =
  | { kind: 'app'; id: string; on: boolean }
  | { kind: 'domain'; id: string; on: boolean }
  | { kind: 'group'; id: string; on: boolean }
  | { kind: 'private-browsing'; on: boolean }
  | { kind: 'include-app'; id: string; on: boolean }
  | { kind: 'include-domain'; id: string; on: boolean }
  | { kind: 'record-only'; on: boolean }
  | { kind: 'member-inclusions'; on: boolean };
type Privacy = CapturePolicy['privacy'];

/** One app or website row: `id` is the bundle id or the domain. `locked`: set by the organization. */
export interface ExclusionRow {
  id: string;
  name: string;
  locked: boolean;
}

export interface ExclusionGroupView {
  id: string;
  name: string;
  description: string;
  /** How many apps / websites it covers; null: unknown. */
  apps: number | null;
  domains: number | null;
  /** What it covers (the app's own lists, `exclusion-groups.json`). */
  members: { apps: string[]; domains: string[] };
  enabled: boolean;
  locked: boolean;
}

export interface ExclusionsView {
  groups: ExclusionGroupView[];
  apps: ExclusionRow[];
  domains: ExclusionRow[];
  privateBrowsing: { excluded: boolean; locked: boolean };
}

export function fromPolicy(
  privacy: Privacy,
  label: (id: CaptureExclusionGroup) => { name: string; description: string },
): ExclusionsView {
  return {
    groups: CAPTURE_EXCLUSION_GROUPS.map((id) => {
      const members = groupsCopy.groups.find((g) => g.id === id) ?? { apps: [], domains: [] };
      return {
        id,
        ...label(id),
        apps: members.apps.length,
        domains: members.domains.length,
        members: { apps: members.apps, domains: members.domains },
        enabled: privacy.exclusion_groups.includes(id),
        locked: false,
      };
    }),
    apps: privacy.excluded_bundle_ids.map((id) => ({ id, name: id, locked: false })),
    domains: privacy.excluded_domains.map((id) => ({ id, name: id, locked: false })),
    privateBrowsing: { excluded: privacy.exclude_private_browsing, locked: false },
  };
}

/** What one tab lists: the categories that cover it and what is excluded. `query` narrows every list by name or id. */
export function exclusionLists(view: ExclusionsView, tab: ExclusionTab, query: string) {
  const q = query.trim().toLowerCase();
  const matches = (...values: string[]) =>
    !q || values.some((value) => value.toLowerCase().includes(q));
  const rows = (list: ExclusionRow[]) =>
    list
      .filter((row) => matches(row.name, row.id))
      .map(({ id, name, locked }) => ({ id, name, locked }));
  const apps = tab === 'apps';
  return {
    categories: view.groups.filter(
      (group) =>
        (apps ? group.apps : group.domains) !== 0 && matches(group.name, group.description),
    ),
    excluded: rows(apps ? view.apps : view.domains),
  };
}

/** The organization policy's privacy with `input` applied. */
export function applyToPrivacy(privacy: Privacy, input: ExclusionChange): Privacy {
  const toggle = <T extends string>(list: T[], id: T, on: boolean) =>
    on ? (list.includes(id) ? list : [...list, id]) : list.filter((item) => item !== id);
  switch (input.kind) {
    case 'app':
      return {
        ...privacy,
        excluded_bundle_ids: toggle(privacy.excluded_bundle_ids, input.id, input.on),
      };
    case 'domain':
      return { ...privacy, excluded_domains: toggle(privacy.excluded_domains, input.id, input.on) };
    case 'group':
      return {
        ...privacy,
        exclusion_groups: toggle(
          privacy.exclusion_groups,
          input.id as CaptureExclusionGroup,
          input.on,
        ),
      };
    case 'private-browsing':
      return { ...privacy, exclude_private_browsing: input.on };
    case 'include-app':
      return {
        ...privacy,
        included_bundle_ids: toggle(privacy.included_bundle_ids ?? [], input.id, input.on),
      };
    case 'include-domain':
      return {
        ...privacy,
        included_domains: toggle(privacy.included_domains ?? [], input.id, input.on),
      };
    case 'record-only':
      return { ...privacy, record_only_included: input.on };
    case 'member-inclusions':
      return { ...privacy, member_inclusions: input.on };
  }
}

export interface IncludedView {
  on: boolean;
  apps: ExclusionRow[];
  domains: ExclusionRow[];
}

/** Record only included apps and websites: the switch and both lists, as rows. */
export function includedView(privacy: Privacy): IncludedView {
  const rows = (list: string[] | undefined): ExclusionRow[] =>
    (list ?? []).map((id) => ({ id, name: id, locked: false }));
  return {
    on: privacy.record_only_included ?? false,
    apps: rows(privacy.included_bundle_ids),
    domains: rows(privacy.included_domains),
  };
}
