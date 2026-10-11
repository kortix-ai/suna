import type { CaptureExclusionGroup, CapturePolicy } from '@kortix/sdk';

import type { DesktopCaptureExclusion, DesktopCaptureExclusions } from '@/lib/desktop';

/**
 * The one model behind every Exclusions screen. Two sources feed it: the
 * engine on this computer (`device` mode: the person's own exclusions, the
 * organization's locked, recently recorded apps and sites) and the account
 * policy (`org` mode: the mandatory lists an admin edits, nothing recorded).
 */
export type ExclusionTab = 'apps' | 'websites';
export type ExclusionChange = DesktopCaptureExclusion;
type Privacy = CapturePolicy['privacy'];

/** The device's built-in categories, in display order (the engine's `exclusion_groups()`). */
export const EXCLUSION_GROUPS: readonly CaptureExclusionGroup[] = [
  'password_managers',
  'messaging',
  'banking',
];

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
  /** How many apps / websites it covers; null when unknown (org mode). */
  apps: number | null;
  domains: number | null;
  enabled: boolean;
  locked: boolean;
}

export interface ExclusionsView {
  groups: ExclusionGroupView[];
  apps: ExclusionRow[];
  domains: ExclusionRow[];
  privateBrowsing: { excluded: boolean; locked: boolean };
  /** Recorded lately on this computer (device mode only). */
  recentApps: Array<ExclusionRow & { excluded: boolean }>;
  recentDomains: Array<ExclusionRow & { excluded: boolean }>;
}

export function fromEngine(data: DesktopCaptureExclusions): ExclusionsView {
  return {
    groups: data.groups.map((group) => ({ ...group, locked: group.by_org })),
    apps: data.excluded_apps.map((app) => ({
      id: app.bundle_id,
      name: app.name,
      locked: app.by_org,
    })),
    domains: data.excluded_domains.map((site) => ({
      id: site.domain,
      name: site.domain,
      locked: site.by_org,
    })),
    privateBrowsing: {
      excluded: data.private_browsing.excluded,
      locked: data.private_browsing.by_org,
    },
    recentApps: data.recent_apps.map((app) => ({
      id: app.bundle_id,
      name: app.name,
      locked: false,
      excluded: app.excluded,
    })),
    recentDomains: data.recent_domains.map((site) => ({
      id: site.domain,
      name: site.domain,
      locked: false,
      excluded: site.excluded,
    })),
  };
}

export function fromPolicy(
  privacy: Privacy,
  label: (id: CaptureExclusionGroup) => { name: string; description: string },
): ExclusionsView {
  return {
    groups: EXCLUSION_GROUPS.map((id) => ({
      id,
      ...label(id),
      apps: null,
      domains: null,
      enabled: privacy.exclusion_groups.includes(id),
      locked: false,
    })),
    apps: privacy.excluded_bundle_ids.map((id) => ({ id, name: id, locked: false })),
    domains: privacy.excluded_domains.map((id) => ({ id, name: id, locked: false })),
    privateBrowsing: { excluded: privacy.exclude_private_browsing, locked: false },
    recentApps: [],
    recentDomains: [],
  };
}

/**
 * What one tab lists: the categories that cover it, what is excluded, and what
 * was recorded lately and is not excluded. `query` narrows every list by name or id.
 */
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
    recent: rows((apps ? view.recentApps : view.recentDomains).filter((row) => !row.excluded)),
  };
}

/** The engine's exclusions as they will read once `input` is applied: the device-mode optimistic update. */
export function applyExclusion(
  data: DesktopCaptureExclusions,
  input: ExclusionChange,
): DesktopCaptureExclusions {
  switch (input.kind) {
    case 'group':
      return {
        ...data,
        groups: data.groups.map((group) =>
          group.id === input.id ? { ...group, enabled: input.on } : group,
        ),
      };
    case 'private-browsing':
      return { ...data, private_browsing: { ...data.private_browsing, excluded: input.on } };
    case 'app': {
      const name = data.recent_apps.find((app) => app.bundle_id === input.id)?.name ?? input.id;
      const rest = data.excluded_apps.filter((app) => app.bundle_id !== input.id);
      return {
        ...data,
        excluded_apps: input.on ? [...rest, { bundle_id: input.id, name, by_org: false }] : rest,
        recent_apps: data.recent_apps.map((app) =>
          app.bundle_id === input.id ? { ...app, excluded: input.on } : app,
        ),
      };
    }
    case 'domain': {
      const present = data.excluded_domains.some((site) => site.domain === input.id);
      const rest = data.excluded_domains.filter((site) => site.domain !== input.id);
      return {
        ...data,
        excluded_domains: input.on
          ? present
            ? data.excluded_domains
            : [...rest, { domain: input.id, by_org: false }]
          : rest,
        recent_domains: data.recent_domains.map((site) =>
          site.domain === input.id ? { ...site, excluded: input.on } : site,
        ),
      };
    }
  }
}

/** The organization policy's privacy with `input` applied: the org-mode edit. */
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
  }
}

/** A domain from what a person types or pastes (scheme, path, port and `www.` go); null when it is not one. */
export function normalizeDomain(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (!host) return null;
  try {
    host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
    ? host
    : null;
}

/** A macOS bundle id or a Windows/Linux program name (`1password.exe`); null otherwise. */
export function normalizeAppId(input: string): string | null {
  const id = input.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(id) ? id : null;
}
