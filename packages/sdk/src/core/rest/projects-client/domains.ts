/**
 * Domain grouping for a project's config entities (agents today; triggers,
 * connectors later). A domain is a display-only classification declared in
 * `kortix.yaml` (`agents.<name>.domain` + the optional top-level `domains:`
 * map). This helper is pure and framework-free — it turns a flat list into
 * ordered groups the dashboard renders as grouped sections. The server never invents
 * a default: an entity with no domain folds into {@link DEFAULT_PROJECT_DOMAIN}
 * here, in the consumer.
 */

/** The group an entity falls into when it declares no `domain`. */
export const DEFAULT_PROJECT_DOMAIN = 'general';

/** A declared domain from the manifest's top-level `domains:` map. */
export interface ProjectDomain {
  /** The domain slug (the key in `domains:`), matched against each entity's `domain`. */
  name: string;
  /** Display label; falls back to the slug when absent. */
  label?: string;
  description?: string;
  /** Sort position among declared domains; lower first. */
  order?: number;
}

/** One rendered group: a domain and the entities in it, in declaration order. */
export interface DomainGroup<T> {
  name: string;
  label: string;
  description?: string;
  items: T[];
  /** True for the fallback bucket that holds entities with no domain. */
  isDefault: boolean;
}

function resolveDomain(raw: string | null | undefined): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || DEFAULT_PROJECT_DOMAIN;
}

/**
 * Group `items` by their `domain`. Ordering: declared domains first (by
 * `order`, then label, then slug), then any referenced-but-undeclared domains
 * alphabetically, then the default bucket last. A declared domain with no items
 * is omitted. With no domains anywhere, returns a single default group holding
 * every item (backward compatible — looks like today's flat list).
 */
export function groupByDomain<T extends { domain?: string | null }>(
  items: T[],
  domains?: ProjectDomain[],
): Array<DomainGroup<T>> {
  const declared = new Map<string, ProjectDomain>();
  for (const d of domains ?? []) if (d?.name) declared.set(d.name, d);

  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const name = resolveDomain(item.domain);
    const bucket = buckets.get(name);
    if (bucket) bucket.push(item);
    else buckets.set(name, [item]);
  }

  const rank = (name: string): [number, number, string] => {
    if (name === DEFAULT_PROJECT_DOMAIN) return [2, 0, name];
    const d = declared.get(name);
    if (d) return [0, d.order ?? Number.MAX_SAFE_INTEGER, (d.label ?? name).toLowerCase()];
    return [1, 0, name.toLowerCase()];
  };

  return [...buckets.keys()]
    .sort((a, b) => {
      const [ga, oa, la] = rank(a);
      const [gb, ob, lb] = rank(b);
      return ga - gb || oa - ob || la.localeCompare(lb);
    })
    .map((name) => {
      const d = declared.get(name);
      return {
        name,
        label: d?.label ?? (name === DEFAULT_PROJECT_DOMAIN ? 'General' : name),
        description: d?.description,
        items: buckets.get(name)!,
        isDefault: name === DEFAULT_PROJECT_DOMAIN,
      };
    });
}
