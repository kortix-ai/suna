/**
 * composer-config — the data behind the composer's chip, the model sheet,
 * and the thread header's agent pill.
 *
 * The project home and the thread share one model sheet. The home lists the
 * project gateway catalog (no provider, no thinking levels); the thread lists
 * the sandbox's models grouped by provider, with the active model's thinking
 * levels. Both map their models to `PickerOption`.
 *
 * Pure data and pure functions only: `bun test` cannot load native modules.
 */

import { selectableProjectAgents, type ProjectConfigSummary } from '@kortix/sdk';
import type { Agent } from '@/lib/opencode/hooks/use-opencode-data';

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

/** The composer chip: its text and its `Button` variant. */
export interface ComposerChip {
  label: string;
  variant: 'ghost' | 'secondary';
}

/**
 * The composer chip (KRTX-247): the agent the send runs on, not the model, as
 * a low-key `ghost` chip. It opens the model sheet, which holds both. When the
 * project offers no model it reads "Connect model" as a `secondary` chip, a
 * clear prompt. With no agent resolved, the model name. Null hides the chip.
 *
 * While the agents still load (a new thread whose sandbox has not answered
 * yet), the chip reads `pendingAgentName` — the agent project home just sent
 * with — or hides. It never shows the model name then: that read as the agent
 * flipping to the model on the way from home to the thread (Jay, 2026-09-27).
 */
export function composerChip(i: {
  connectModel: boolean;
  agentName: string | null | undefined;
  modelName: string | null | undefined;
  /** The agent the last send used, shown until `agentName` resolves. */
  pendingAgentName?: string | null;
  /** The agent list has not loaded yet. */
  agentsLoading?: boolean;
}): ComposerChip | null {
  if (i.connectModel) return { label: 'Connect model', variant: 'secondary' };
  const agentName = i.agentName || (i.agentsLoading ? i.pendingAgentName : null);
  if (!agentName && i.agentsLoading) return null;
  const label = agentName ? agentDisplayName(agentName) : i.modelName;
  return label ? { label, variant: 'ghost' } : null;
}

/**
 * The agents a thread can run, from the Kortix project config: the SDK's
 * `selectableProjectAgents`, default first. Never the sandbox's `/agent` list,
 * which adds the runtime's built-ins (`build`, `plan`, `explore`, `general`).
 * A missing `mode` is OpenCode's default, `all`.
 */
export function threadAgents(config: ProjectConfigSummary): Agent[] {
  return selectableProjectAgents(config).map((a) => ({
    name: a.name,
    description: a.description ?? undefined,
    mode: a.mode === 'primary' ? 'primary' : 'all',
    options: {},
  }));
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
