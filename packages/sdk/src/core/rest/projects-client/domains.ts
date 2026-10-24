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

/** One block of a Space's agent-configurable surface: a chat room (shared
 *  durable session), an artifact (a Files/Drive path), an app (a Kortix App
 *  slug), an iframe (a url), or text (markdown). The inside of a Space is not
 *  rigid UI — an agent lays it out as blocks (v1: a simple grid). Display/config
 *  only; the running instance is resolved at render. */
export interface SpaceBlock {
  type: 'chat' | 'artifact' | 'app' | 'iframe' | 'text';
  label?: string;
  /** chat: a stable room/channel key → a shared durable session. */
  room?: string;
  /** artifact: a Files/Drive path (doc or html page). */
  path?: string;
  /** app: a Kortix App slug. */
  app?: string;
  /** iframe: a url to embed in a sandboxed frame. */
  url?: string;
  /** text: markdown content. */
  text?: string;
}

/** A declared domain (Space) from the manifest's top-level `domains:` map. */
export interface ProjectDomain {
  /** The domain slug (the key in `domains:`), matched against each entity's `domain`. */
  name: string;
  /** Display label; falls back to the slug when absent. */
  label?: string;
  description?: string;
  /** Sort position among declared domains; lower first. */
  order?: number;
  /** The Space's agent-configurable blocks, in order. */
  blocks?: SpaceBlock[];
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
  return groupInto(items, domains, (item) => item.domain, 'General');
}

function declaredMap(domains?: ProjectDomain[]): Map<string, ProjectDomain> {
  const declared = new Map<string, ProjectDomain>();
  for (const d of domains ?? []) if (d?.name) declared.set(d.name, d);
  return declared;
}

/** Declared first (by `order`, label, slug), then undeclared alphabetically, then the default. */
function bySpaceRank(declared: Map<string, ProjectDomain>) {
  const rank = (name: string): [number, number, string] => {
    if (name === DEFAULT_PROJECT_DOMAIN) return [2, 0, name];
    const d = declared.get(name);
    if (d) return [0, d.order ?? Number.MAX_SAFE_INTEGER, (d.label ?? name).toLowerCase()];
    return [1, 0, name.toLowerCase()];
  };
  return (a: string, b: string) => {
    const [ga, oa, la] = rank(a);
    const [gb, ob, lb] = rank(b);
    return ga - gb || oa - ob || la.localeCompare(lb);
  };
}

function groupInto<T>(
  items: T[],
  domains: ProjectDomain[] | undefined,
  nameOf: (item: T) => string | null | undefined,
  defaultLabel: string,
): Array<DomainGroup<T>> {
  const declared = declaredMap(domains);
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const name = resolveDomain(nameOf(item));
    const bucket = buckets.get(name);
    if (bucket) bucket.push(item);
    else buckets.set(name, [item]);
  }
  return [...buckets.keys()].sort(bySpaceRank(declared)).map((name) => {
    const d = declared.get(name);
    return {
      name,
      label: d?.label ?? (name === DEFAULT_PROJECT_DOMAIN ? defaultLabel : name),
      description: d?.description,
      items: buckets.get(name)!,
      isDefault: name === DEFAULT_PROJECT_DOMAIN,
    };
  });
}

/**
 * Where a viewable resource (an App, a Goal, an Artifact) is grouped. Both
 * fields are optional; neither means project-wide. Grouping only: a binding
 * never grants access (`agents.<name>.apps` and the other grants stay the only
 * permission source). `Artifact`, `AppDisplay` and `ProjectGoalDocument` each
 * satisfy it structurally.
 */
export interface ResourceBinding {
  /** A space slug: a key of the manifest's `domains:` map. */
  space?: string | null;
  /** An agent name, a built-in agent included. */
  agent?: string | null;
}

/**
 * The space a binding resolves to: its `space`, else the `domain` of its
 * `agent` in the manifest, else null (project-wide). A name that resolves to
 * nothing is never an error: an unknown space groups under its own slug, and
 * an unknown agent counts as having no space.
 */
export function bindingSpace(
  binding: ResourceBinding | null | undefined,
  agents: ReadonlyArray<{ name: string; domain?: string | null }>,
): string | null {
  const space = binding?.space?.trim();
  if (space) return space;
  const agent = binding?.agent?.trim();
  if (!agent) return null;
  return agents.find((a) => a.name === agent)?.domain?.trim() || null;
}

/** The names of the agents whose `domain` is `slug`, in manifest order. */
export function agentsInSpace(
  slug: string,
  agents: ReadonlyArray<{ name: string; domain?: string | null }>,
): string[] {
  return agents.filter((a) => a.domain?.trim() === slug).map((a) => a.name);
}

/**
 * Group resources by space, in `groupByDomain`'s order: declared spaces, then
 * undeclared ones, then the default group (label "Project-wide") last.
 * `spaceOf` names an item's space; for a bound resource pass
 * `(item) => bindingSpace(item, config.agents)`.
 */
export function groupBySpace<T>(
  items: T[],
  spaces?: ProjectDomain[],
  spaceOf: (item: T) => string | null | undefined = (item) => (item as { space?: string | null }).space,
): Array<DomainGroup<T>> {
  return groupInto(items, spaces, spaceOf, 'Project-wide');
}

/**
 * Every space of a project, in order: the declared ones (an empty space
 * included), then the ones agents reference without declaring. Never the
 * default group. The Spaces nav lists these.
 */
export function listSpaces(
  config: { agents?: ReadonlyArray<{ name: string; domain?: string | null }>; domains?: ProjectDomain[] } | null | undefined,
): ProjectDomain[] {
  const declared = declaredMap(config?.domains);
  const names = new Set(declared.keys());
  for (const agent of config?.agents ?? []) {
    const name = agent.domain?.trim();
    if (name) names.add(name);
  }
  names.delete(DEFAULT_PROJECT_DOMAIN);
  return [...names].sort(bySpaceRank(declared)).map((name) => declared.get(name) ?? { name });
}
