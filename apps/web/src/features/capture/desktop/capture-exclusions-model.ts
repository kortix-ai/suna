import type { DesktopCaptureExclusion, DesktopCaptureExclusions } from '@/lib/desktop';

export type ExclusionTab = 'apps' | 'websites';

/** One app or website row: `id` is the bundle id or the domain. */
export interface ExclusionRow {
  id: string;
  name: string;
  byOrg: boolean;
}

/**
 * What one tab of Exclusions lists: the categories that cover it, what is
 * excluded, and what was recorded lately and is not excluded. `query` narrows
 * every list by name or id.
 */
export function exclusionLists(data: DesktopCaptureExclusions, tab: ExclusionTab, query: string) {
  const q = query.trim().toLowerCase();
  const matches = (...values: string[]) =>
    !q || values.some((value) => value.toLowerCase().includes(q));
  if (tab === 'apps') {
    return {
      categories: data.groups.filter(
        (group) => group.apps > 0 && matches(group.name, group.description),
      ),
      excluded: data.excluded_apps
        .filter((app) => matches(app.name, app.bundle_id))
        .map((app): ExclusionRow => ({ id: app.bundle_id, name: app.name, byOrg: app.by_org })),
      recent: data.recent_apps
        .filter((app) => !app.excluded && matches(app.name, app.bundle_id))
        .map((app): ExclusionRow => ({ id: app.bundle_id, name: app.name, byOrg: false })),
    };
  }
  return {
    categories: data.groups.filter(
      (group) => group.domains > 0 && matches(group.name, group.description),
    ),
    excluded: data.excluded_domains
      .filter((site) => matches(site.domain))
      .map((site): ExclusionRow => ({ id: site.domain, name: site.domain, byOrg: site.by_org })),
    recent: data.recent_domains
      .filter((site) => !site.excluded && matches(site.domain))
      .map((site): ExclusionRow => ({ id: site.domain, name: site.domain, byOrg: false })),
  };
}

/** The exclusions as they will read once `input` is applied: the optimistic update. */
export function applyExclusion(
  data: DesktopCaptureExclusions,
  input: DesktopCaptureExclusion,
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
      const rest = data.excluded_domains.filter((site) => site.domain !== input.id);
      const current = data.excluded_domains.find((site) => site.domain === input.id);
      return {
        ...data,
        excluded_domains: input.on
          ? current
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
