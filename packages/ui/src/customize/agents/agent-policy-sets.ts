import { parseManifestText } from '@kortix/manifest-schema';
import type { AgentGrantSetV2 } from '@kortix/sdk';

/**
 * The agent side of connector policy sets: `agents.<a>.policy_sets` maps a
 * connector slug to one of that connector's sets (`connectors[].policy_sets`).
 * An absent key means the base rules.
 */

export interface PolicySetOption {
  name: string;
  description?: string;
}

/**
 * Every connector's set names, read from the root kortix.yaml. The agent page
 * already holds the raw manifest, so the editor needs no request per connector.
 * ponytail: connectors declared in an `imports:` file are not read; an agent
 * that names a set on one still shows its value, flagged as missing.
 */
export function connectorPolicySetOptions(
  manifestRaw: string | null | undefined,
): Record<string, PolicySetOption[]> {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = manifestRaw ? parseManifestText(manifestRaw, 'yaml') : {};
  } catch {
    return {};
  }
  const out: Record<string, PolicySetOption[]> = Object.create(null);
  const connectors = Array.isArray(manifest.connectors) ? manifest.connectors : [];
  for (const entry of connectors) {
    if (!entry || typeof entry !== 'object') continue;
    const { slug, policy_sets: sets } = entry as { slug?: unknown; policy_sets?: unknown };
    if (typeof slug !== 'string' || !sets || typeof sets !== 'object' || Array.isArray(sets)) continue;
    const options = Object.entries(sets as Record<string, unknown>).map(([name, set]) => {
      const description = (set as { description?: unknown } | null)?.description;
      return typeof description === 'string' && description ? { name, description } : { name };
    });
    if (options.length > 0) out[slug] = options;
  }
  return out;
}

/**
 * One connector's set choice; `null` (or `base`) clears it. Clearing the last
 * entry returns `{}`, never `undefined`: the config PUT keeps the declared
 * `policy_sets` when the key is omitted, so `{}` is what removes it.
 *
 * Entries on connectors the agent no longer holds are kept on purpose: they
 * are inert until the connector is granted again, and dropping one is a set
 * change that needs project.connector.write.
 */
export function withPolicySet(
  policySets: Record<string, string> | undefined,
  slug: string,
  name: string | null,
): Record<string, string> {
  const next = Object.fromEntries(Object.entries(policySets ?? {}).filter(([key]) => key !== slug));
  if (name && name !== 'base') next[slug] = name;
  return next;
}

export interface PolicySetRow {
  slug: string;
  options: PolicySetOption[];
  /** The set the agent names, or null for the base rules. */
  value: string | null;
  /** The agent names a set the connector does not define: calls are blocked. */
  missing: boolean;
}

/**
 * The rows of the agent's "Rule sets" list: every granted connector that
 * defines at least one set, plus every connector the agent already names a set
 * on (so a stale entry is visible and can be cleared).
 */
export function policySetRows(
  grant: AgentGrantSetV2 | undefined,
  catalog: Record<string, PolicySetOption[]>,
  policySets: Record<string, string> | undefined,
  /** Slugs of the project's connectors, in display order. */
  connectorSlugs: readonly string[],
): PolicySetRow[] {
  const granted = (slug: string) =>
    grant === 'all' || (Array.isArray(grant) && grant.includes(slug));
  const assigned = policySets ?? {};
  const slugs = [
    ...connectorSlugs.filter((slug) => granted(slug) && (catalog[slug]?.length || Object.hasOwn(assigned, slug))),
    ...Object.keys(assigned).filter((slug) => !connectorSlugs.includes(slug)),
  ];
  return slugs.map((slug) => {
    const options = catalog[slug] ?? [];
    const value = Object.hasOwn(assigned, slug) ? (assigned[slug] ?? null) : null;
    return {
      slug,
      options,
      value,
      missing: value !== null && !options.some((option) => option.name === value),
    };
  });
}
