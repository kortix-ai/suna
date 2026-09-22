/**
 * composer-config — the data behind the composer's model pill, the model
 * sheet, and the thread header's agent pill.
 *
 * The project home and the thread share one model sheet. The home lists the
 * project gateway catalog (no provider, no thinking levels); the thread lists
 * the sandbox's models grouped by provider, with the active model's thinking
 * levels. Both map their models to `PickerOption`.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

export interface PickerOption {
  /** Unique row id: the gateway wire id (home) or `providerID/modelID` (thread). */
  key: string;
  label: string;
  /** Provider name. Options without one form a single untitled section. */
  group?: string;
  /** Extra search text that is not shown, e.g. the raw model id. */
  keywords?: string;
}

export interface PickerSection {
  title: string | undefined;
  options: PickerOption[];
}

/** The search field shows only when the list is longer than this. */
export const PICKER_SEARCH_THRESHOLD = 8;

export function showsPickerSearch(optionCount: number): boolean {
  return optionCount > PICKER_SEARCH_THRESHOLD;
}

/**
 * Rows for the sheet: filtered by the query, then grouped by provider in
 * first-seen order. Row order inside a group is the input order.
 */
export function pickerSections(options: PickerOption[], query: string): PickerSection[] {
  const q = query.trim().toLowerCase();
  const matches = q
    ? options.filter((o) => `${o.label} ${o.group ?? ''} ${o.keywords ?? ''}`.toLowerCase().includes(q))
    : options;

  const sections: PickerSection[] = [];
  const byGroup = new Map<string | undefined, PickerSection>();
  for (const option of matches) {
    let section = byGroup.get(option.group);
    if (!section) {
      section = { title: option.group, options: [] };
      byGroup.set(option.group, section);
      sections.push(section);
    }
    section.options.push(option);
  }
  return sections;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** A thinking level's name. `null` is the model's standard response. */
export function variantDisplayName(variant: string | null): string {
  return variant ? capitalise(variant) : 'Default';
}

/** Pill text on the thread composer: the model, then the thinking level when one is set. */
export function composerPillLabel(modelName: string | undefined, variant: string | null | undefined): string {
  if (!modelName) return 'Model';
  return variant ? `${modelName} · ${variantDisplayName(variant)}` : modelName;
}

/**
 * Agents a user can run a thread on: primary agents that are not hidden or
 * disabled. Takes the sandbox's agents (thread) and the project config's
 * (`/detail`, project home), whose `mode` is null when the agent file omits
 * it — OpenCode reads that as "all".
 */
export function pickableAgents<T extends { mode?: string | null; hidden?: boolean; enabled?: boolean }>(
  agents: T[],
): T[] {
  return agents.filter((a) => {
    const mode = a.mode ?? 'all';
    return (mode === 'primary' || mode === 'all') && !a.hidden && a.enabled !== false;
  });
}

/**
 * The agent project home starts a session on. Web's order
 * (`resolveCurrentAgentName`): the pick made on this screen, else the project's
 * declared default, else the last agent the user picked anywhere. A name the
 * project cannot run is skipped. Null: no agent is sent and the server decides.
 */
export function homeAgentName(
  pickableNames: string[],
  input: { picked: string | null; projectDefault: string | null | undefined; lastUsed: string | null },
): string | null {
  for (const name of [input.picked, input.projectDefault, input.lastUsed]) {
    if (name && pickableNames.includes(name)) return name;
  }
  return null;
}

export function agentDisplayName(name: string | undefined): string {
  return name ? capitalise(name) : 'Agent';
}

/**
 * The thinking slider: `count` evenly spaced stops over `travel` points of
 * thumb movement. Both run on the UI thread during a drag (`'worklet'`).
 */
export function stopOffset(index: number, travel: number, count: number): number {
  'worklet';
  if (count < 2) return 0;
  return (index * travel) / (count - 1);
}

/** The stop closest to a thumb offset. Offsets outside the track clamp to the ends. */
export function nearestStop(offset: number, travel: number, count: number): number {
  'worklet';
  if (count < 2 || travel <= 0) return 0;
  const index = Math.round((offset / travel) * (count - 1));
  return Math.min(count - 1, Math.max(0, index));
}
