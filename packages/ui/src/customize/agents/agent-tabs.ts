/**
 * The agent page's address: four tabs, and a view inside Access and Runtime.
 * The page draws them as ONE rail (2026-10-28): Overview, Triggers, then the
 * Access views and the Runtime views under their group labels. The address
 * keeps its two levels, so every link still resolves.
 *
 *   ?tab=overview | access | runtime | triggers
 *   ?tab=access&view=connectors | secrets | skills | tools | extensions | drives | apps | permissions | …
 *   ?tab=runtime&view=model | workspace
 *
 * The page used to be a rail of seventeen `?section=<key>` topics, then six
 * tabs. Tools moved from Runtime to Access (2026-10-27): `?tab=runtime&view=tools`
 * opens Access. Every old link still resolves: `resolveAgentLocation` maps
 * `?section=` onto a tab and a view (Basics became the Overview's
 * Availability panel). Instructions and People are no tabs any more: the
 * instructions are edited on the Overview, and People is the header's Share
 * dialog. Their old links open the Overview with the instructions in focus or
 * the Share dialog open (`open`).
 */

import type { AgentConfigSectionKey } from '../sections/view/agent-editor';

export const AGENT_TABS = ['overview', 'access', 'runtime', 'triggers'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** Access views, in the order the segmented control lists them. */
export const ACCESS_VIEWS = [
  'connectors',
  'secrets',
  'skills',
  'tools',
  'extensions',
  'drives',
  'apps',
  'actions',
  'subagents',
  'commands',
] as const satisfies readonly AgentConfigSectionKey[];
export type AccessView = (typeof ACCESS_VIEWS)[number];

export const RUNTIME_VIEWS = ['model', 'workspace'] as const satisfies readonly AgentConfigSectionKey[];
export type RuntimeView = (typeof RUNTIME_VIEWS)[number];

/** The URL word for a view. `actions` reads as `permissions` in a link. */
export function viewParam(view: AgentConfigSectionKey): string {
  return view === 'actions' ? 'permissions' : view;
}

function viewFromParam(value: string | null): AgentConfigSectionKey | null {
  if (!value) return null;
  if (value === 'permissions') return 'actions';
  return value as AgentConfigSectionKey;
}

/** Which tab owns a legacy `?section=` key. */
function tabOfSection(section: AgentConfigSectionKey): AgentTab {
  if ((ACCESS_VIEWS as readonly string[]).includes(section)) return 'access';
  if ((RUNTIME_VIEWS as readonly string[]).includes(section)) return 'runtime';
  if (section === 'basics' || section === 'instructions' || section === 'people') return 'overview';
  return section as AgentTab;
}

/** What a retired tab's link opens on the Overview. */
export type AgentOverlay = 'instructions' | 'share';
const RETIRED_TABS: Record<string, AgentOverlay> = { instructions: 'instructions', people: 'share' };

export interface AgentLocation {
  tab: AgentTab;
  /** The Access or Runtime view; null on every other tab. */
  view: AgentConfigSectionKey | null;
  /** Set by a retired tab's link: the instructions in focus, or the Share dialog open. */
  open?: AgentOverlay;
}

/**
 * The tab and view a URL names, limited to what this agent has (`tabs`, and
 * `views` for Access and Runtime). An unknown or unavailable value falls back
 * to the first entry, never to a blank page.
 */
export function resolveAgentLocation(
  params: { tab: string | null; view: string | null; section: string | null },
  tabs: readonly AgentTab[],
  views: readonly AgentConfigSectionKey[],
): AgentLocation {
  const retired = RETIRED_TABS[params.tab ?? ''] ?? (params.tab ? undefined : RETIRED_TABS[params.section ?? '']);
  if (retired) return { tab: 'overview', view: null, open: retired };
  let tab = (params.tab as AgentTab | null) ?? null;
  let view = viewFromParam(params.view);
  const legacy = viewFromParam(params.section);
  if (!tab && legacy) {
    tab = tabOfSection(legacy);
    view = tab === 'access' || tab === 'runtime' ? legacy : null;
  }
  // A view that moved tabs (Tools: Runtime → Access) follows its view.
  if ((tab === 'access' || tab === 'runtime') && view && tabOfSection(view) !== tab) {
    const owner = tabOfSection(view);
    if (owner === 'access' || owner === 'runtime') tab = owner;
  }
  if (!tab || !tabs.includes(tab)) tab = tabs[0] ?? 'overview';
  if (tab !== 'access' && tab !== 'runtime') return { tab, view: null };
  const own = (tab === 'access' ? ACCESS_VIEWS : RUNTIME_VIEWS) as readonly AgentConfigSectionKey[];
  const available = own.filter((key) => views.includes(key));
  return { tab, view: view && available.includes(view) ? view : (available[0] ?? null) };
}

export function agentLocationHref(pathname: string, tab: AgentTab, view?: AgentConfigSectionKey | null): string {
  if (tab === 'overview' && !view) return pathname;
  return view ? `${pathname}?tab=${tab}&view=${viewParam(view)}` : `${pathname}?tab=${tab}`;
}

/** The href of a legacy section key: where an old Overview row or link lands now. */
export function sectionLocationHref(pathname: string, section: AgentConfigSectionKey): string {
  const tab = tabOfSection(section);
  return agentLocationHref(pathname, tab, tab === 'access' || tab === 'runtime' ? section : null);
}

const OVERVIEW_FIELDS = new Set([
  'enabled',
  'space',
  'behavior.hidden',
  'behavior.mode',
  'behavior.prompt',
  'behavior.description',
]);
/** The Access view that edits each field. */
const ACCESS_FIELDS: Record<string, AccessView> = {
  tools: 'tools',
  'behavior.permission': 'tools',
  skills: 'skills',
  connectors: 'connectors',
  connectors_required: 'connectors',
  secrets: 'secrets',
  apps: 'apps',
  kortix_permissions: 'actions',
  kortix_cli: 'actions',
  subagents: 'subagents',
  commands: 'commands',
  extensions: 'extensions',
};
const WORKSPACE_FIELDS = new Set(['sandbox', 'workspace', 'repository_access']);

function fields(block: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(block)) {
    if (key === 'behavior' && value && typeof value === 'object') {
      for (const [inner, v] of Object.entries(value)) out.set(`behavior.${inner}`, JSON.stringify(v));
    } else out.set(key, JSON.stringify(value));
  }
  return out;
}

/** One row of the agent page's rail: a tab with no views, or a view. */
export type AgentRailKey = 'overview' | 'triggers' | AgentConfigSectionKey;

/** The rail row a location shows. */
export function railKeyOf(location: AgentLocation): AgentRailKey {
  return location.view ?? (location.tab === 'triggers' ? 'triggers' : 'overview');
}

/**
 * The rail rows that hold an unsaved edit: each changed field of the draft,
 * mapped to the row that edits it. A field no other row owns (model,
 * temperature, the prompt's runtime knobs) belongs to Model.
 */
export function changedItems(draft: object, baseline: object): AgentRailKey[] {
  const a = fields(draft as Record<string, unknown>);
  const b = fields(baseline as Record<string, unknown>);
  const changed = new Set<AgentRailKey>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) === b.get(key)) continue;
    changed.add(
      OVERVIEW_FIELDS.has(key)
        ? 'overview'
        : (ACCESS_FIELDS[key] ?? (WORKSPACE_FIELDS.has(key) ? 'workspace' : 'model')),
    );
  }
  return [...changed];
}

/** Edit distance, for the not-found page's "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return row[b.length];
}

/** The agent name closest to a missing one, when it is close enough to be a typo. */
export function closestAgentName(missing: string, names: readonly string[]): string | null {
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const d = name.includes(missing) || missing.includes(name) ? 1 : distance(missing, name);
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= Math.max(2, Math.floor(missing.length / 3)) ? best.name : null;
}
