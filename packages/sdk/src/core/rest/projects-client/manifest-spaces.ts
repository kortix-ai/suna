/**
 * Spaces. A space is a channel: a room where people and agents post, plus the
 * tabs the space configures (Goals, Apps, Artifacts, Files, a Board, a pinned
 * App, Artifact or link). It is declared in `kortix.yaml` as `spaces.<slug>`,
 * and an agent joins one with `agents.<name>.space`. Apps, Goals and
 * Artifacts bind to a space or to an agent (`ResourceBinding`).
 *
 * Pure and framework-free: these helpers turn the config summary into the
 * ordered lists, groups and tabs a host renders.
 */

/** The group of a resource bound to no space: the Project-wide bucket. Not a
 *  valid space slug (a slug starts with a letter or a digit), so a space named
 *  `general` never collides with it. */
export const PROJECT_WIDE_SPACE = '_project';

/** One block of a board tab: a room, a file, an App, an embedded page or text. */
export interface SpaceBlock {
  type: 'chat' | 'artifact' | 'app' | 'iframe' | 'text';
  label?: string;
  /** chat: the name of a project room. */
  room?: string;
  /** artifact: a project file path. */
  path?: string;
  /** app: a Kortix App slug. */
  app?: string;
  /** iframe: a url to embed in a sandboxed frame. */
  url?: string;
  /** text: markdown content. */
  text?: string;
}

/** The tab types after the room tab. The room tab is implicit and always first. */
export type SpaceTabType = 'goals' | 'apps' | 'artifacts' | 'files' | 'board' | 'app' | 'artifact' | 'link';

/** One configured tab of a space (`spaces.<slug>.tabs[]`). */
export interface SpaceTab {
  type: SpaceTabType;
  /** The tab's name. Absent: the host names it by type or target. */
  label?: string;
  /** files: a project folder path. */
  path?: string;
  /** app: a Kortix App slug. */
  app?: string;
  /** artifact: an `artifact_id`. */
  artifact?: string;
  /** link: an http(s) url. */
  url?: string;
  /** link: true embeds the page; absent or false shows a link card. */
  embed?: boolean;
  /** board: the grid's blocks, in order. */
  blocks?: SpaceBlock[];
}

/** One item of a space header (`spaces.<slug>.header[]`). */
export type SpaceHeaderItem = 'agents' | 'members' | 'needs_you' | 'new_session' | 'ask_my_kortix';

/** What a header shows when the space configures none: every item. */
export const DEFAULT_SPACE_HEADER: readonly SpaceHeaderItem[] = [
  'agents',
  'members',
  'needs_you',
  'new_session',
  'ask_my_kortix',
];

/** The tabs a space shows after its room when it configures none. */
export const DEFAULT_SPACE_TABS: readonly SpaceTab[] = [{ type: 'goals' }, { type: 'apps' }, { type: 'artifacts' }];

/** A space of the project: a `spaces:` entry, or a slug an agent names. */
export interface ManifestSpace {
  /** The slug: the key in `spaces:`, and the name of the space's room. */
  name: string;
  /** Display label; falls back to the slug. */
  label?: string;
  description?: string;
  /** Sort position among declared spaces; lower first. */
  order?: number;
  /** What the header shows, in order. Absent: `DEFAULT_SPACE_HEADER`. */
  header?: SpaceHeaderItem[];
  /** The tabs after the room, in order. Absent: `DEFAULT_SPACE_TABS`. */
  tabs?: SpaceTab[];
}

/** One rendered group: a space and the items in it, in input order. */
export interface SpaceGroup<T> {
  name: string;
  label: string;
  description?: string;
  items: T[];
  /** True for the Project-wide bucket. */
  isDefault: boolean;
}

/** The tabs a space shows after its room: its own, else the defaults. */
export function spaceTabs(space: ManifestSpace): readonly SpaceTab[] {
  return space.tabs ?? DEFAULT_SPACE_TABS;
}

/** The header items a space shows: its own, else every item. */
export function spaceHeader(space: ManifestSpace): readonly SpaceHeaderItem[] {
  return space.header ?? DEFAULT_SPACE_HEADER;
}

/**
 * The stable key of a tab, for a `?tab=` deep link. A view is its type, a
 * pinned App or Artifact is its target; a board, a link and a folder are their
 * position (`board-2`). The room tab is `room`.
 */
export function spaceTabKey(tab: SpaceTab, index: number): string {
  if (tab.type === 'goals' || tab.type === 'apps' || tab.type === 'artifacts') return tab.type;
  if (tab.type === 'app' && tab.app) return `app-${tab.app}`;
  if (tab.type === 'artifact' && tab.artifact) return `artifact-${tab.artifact}`;
  return `${tab.type}-${index}`;
}

type SpaceMember = { name: string; space?: string | null };

function declaredMap(spaces?: ManifestSpace[]): Map<string, ManifestSpace> {
  const declared = new Map<string, ManifestSpace>();
  for (const s of spaces ?? []) if (s?.name) declared.set(s.name, s);
  return declared;
}

/** Declared first (by `order`, label, slug), then undeclared alphabetically, then Project-wide. */
function bySpaceRank(declared: Map<string, ManifestSpace>) {
  const rank = (name: string): [number, number, string] => {
    if (name === PROJECT_WIDE_SPACE) return [2, 0, name];
    const s = declared.get(name);
    if (s) return [0, s.order ?? Number.MAX_SAFE_INTEGER, (s.label ?? name).toLowerCase()];
    return [1, 0, name.toLowerCase()];
  };
  return (a: string, b: string) => {
    const [ga, oa, la] = rank(a);
    const [gb, ob, lb] = rank(b);
    return ga - gb || oa - ob || la.localeCompare(lb);
  };
}

/**
 * Where a viewable resource (an App, a Goal, an Artifact) is grouped. Both
 * fields are optional; neither means project-wide. Grouping only: a binding
 * never grants access (`agents.<name>.apps` and the other grants stay the only
 * permission source). `Artifact`, `AppDisplay` and `ProjectGoalDocument` each
 * satisfy it structurally.
 */
export interface ResourceBinding {
  /** A space slug: a key of the manifest's `spaces:` map. */
  space?: string | null;
  /** An agent name, a built-in agent included. */
  agent?: string | null;
}

/**
 * The space a binding resolves to: its `space`, else the `space` of its
 * `agent`, else null (project-wide). A name that resolves to nothing is never
 * an error: an unknown space groups under its own slug, and an unknown agent
 * counts as having no space.
 */
export function bindingSpace(
  binding: ResourceBinding | null | undefined,
  agents: ReadonlyArray<SpaceMember>,
): string | null {
  const space = binding?.space?.trim();
  if (space) return space;
  const agent = binding?.agent?.trim();
  if (!agent) return null;
  return agents.find((a) => a.name === agent)?.space?.trim() || null;
}

/** The names of the agents whose `space` is `slug`, in manifest order. */
export function agentsInSpace(slug: string, agents: ReadonlyArray<SpaceMember>): string[] {
  return agents.filter((a) => a.space?.trim() === slug).map((a) => a.name);
}

/**
 * Group items by space: declared spaces (by `order`, label, slug), then
 * undeclared ones alphabetically, then Project-wide (`PROJECT_WIDE_SPACE`)
 * last. A declared space with no items is omitted. `spaceOf` names an item's
 * space and defaults to its `space` field; for a bound resource pass
 * `(item) => bindingSpace(item, config.agents)`.
 */
export function groupBySpace<T>(
  items: T[],
  spaces?: ManifestSpace[],
  spaceOf: (item: T) => string | null | undefined = (item) => (item as { space?: string | null }).space,
): Array<SpaceGroup<T>> {
  const declared = declaredMap(spaces);
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const raw = spaceOf(item);
    const name = (typeof raw === 'string' ? raw.trim() : '') || PROJECT_WIDE_SPACE;
    const bucket = buckets.get(name);
    if (bucket) bucket.push(item);
    else buckets.set(name, [item]);
  }
  return [...buckets.keys()].sort(bySpaceRank(declared)).map((name) => {
    const s = declared.get(name);
    return {
      name,
      label: s?.label ?? (name === PROJECT_WIDE_SPACE ? 'Project-wide' : name),
      description: s?.description,
      items: buckets.get(name)!,
      isDefault: name === PROJECT_WIDE_SPACE,
    };
  });
}

/**
 * Every space of a project, in order: the declared ones (an empty space
 * included), then the ones agents name without declaring. The sidebar lists
 * these.
 */
export function listSpaces(
  config: { agents?: ReadonlyArray<SpaceMember>; spaces?: ManifestSpace[] } | null | undefined,
): ManifestSpace[] {
  const declared = declaredMap(config?.spaces);
  const names = new Set(declared.keys());
  for (const agent of config?.agents ?? []) {
    const name = agent.space?.trim();
    if (name) names.add(name);
  }
  return [...names].sort(bySpaceRank(declared)).map((name) => declared.get(name) ?? { name });
}
