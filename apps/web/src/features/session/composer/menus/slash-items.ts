import type { Command } from '@kortix/sdk/react';

import { filterSlashActions, SLASH_ACTIONS, type SlashAction } from './slash-actions';

export interface SlashRow {
  index: number;
  type: 'command' | 'action';
  name: string;
  description: string;
  hint?: string;
  /** The control's current setting — see `SlashAction.value`. */
  value?: string;
  command?: Command;
  action?: SlashAction;
}

export interface SlashSection {
  heading: string;
  rows: SlashRow[];
  /**
   * Render the rows without their heading.
   *
   * Only Actions sets this. Its rows are the fixed, always-present ones and
   * they render first, so a heading above them would be labelling the top of
   * the list rather than separating anything — the headings below still do
   * the separating, which is the job headings are here for. `heading` itself
   * stays populated: it is the React key, and `SlashRowIcon` reads it to pick
   * a command row's glyph.
   */
  hideHeading?: boolean;
}

type CommandBucket = 'skill' | 'mcp' | 'command';

const BUCKET_HEADING: Record<CommandBucket, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  command: 'Commands',
};

/**
 * Fixed render order for the command buckets: Skills, then plain Commands,
 * then MCP.
 *
 * MCP moved from the middle to the end. Skills and Commands are things the
 * user or the project authored and reaches for by name; MCP rows arrive from
 * whatever servers happen to be connected and are the least likely to be what
 * someone opened the palette to find, so they sit furthest from the caret.
 */
const BUCKET_ORDER: CommandBucket[] = ['skill', 'command', 'mcp'];

function bucketFor(command: Command): CommandBucket {
  if (command.source === 'skill') return 'skill';
  if (command.source === 'mcp') return 'mcp';
  return 'command';
}

export interface CommandGroup {
  heading: string;
  commands: Command[];
}

/**
 * Groups Commands rows by `Command.source` ("command" | "mcp" | "skill" |
 * undefined — `@opencode-ai/sdk` `dist/v2/gen/types.gen.d.ts:1974`) into
 * Skills / MCP / Commands headings. Nothing upstream filters on `source`, so
 * skill-backed commands already arrive through `command.list()` mixed in with
 * everything else; this is what gives them their own heading.
 *
 * Every group carries its OWN bucket's heading, including when only one bucket
 * is non-empty. An earlier version collapsed the single-bucket case onto a flat
 * "Commands" heading, to avoid a lone "Skills" heading with nothing to contrast
 * against. That reasoned about the UNFILTERED list only, and it produced a
 * visible bug the moment a query narrowed the list: typing `/web` against a
 * real workspace (skills + plain commands) dropped every non-skill row, which
 * left one non-empty bucket, which relabelled the SAME rows from "Skills" to
 * "Commands" mid-keystroke. A heading that changes identity while you type
 * reads as the list having been replaced. Observed on a live session at
 * localhost:13400 — the rows under it were byte-identical before and after.
 *
 * The lone-heading case the old rule guarded against is not a defect: a list of
 * only skills labelled "Skills" is accurate, and it is what the reference UX
 * shows. `source: undefined` still lands in the `command` bucket and still
 * renders "Commands", so a server that never populates `source` is unaffected.
 */
export function groupCommandsBySource(commands: Command[]): CommandGroup[] {
  if (commands.length === 0) return [];

  const buckets: Record<CommandBucket, Command[]> = { skill: [], mcp: [], command: [] };
  for (const command of commands) buckets[bucketFor(command)].push(command);

  return BUCKET_ORDER.filter((bucket) => buckets[bucket].length > 0).map((bucket) => ({
    heading: BUCKET_HEADING[bucket],
    commands: buckets[bucket],
  }));
}

function commandMatchesQuery(command: Command, q: string): boolean {
  return (
    (command.name || '').toLowerCase().includes(q) ||
    (command.description || '').toLowerCase().includes(q)
  );
}

export interface BuildSlashSectionsInput {
  commands: Command[];
  /** Defaults to `SLASH_ACTIONS`; overridable for tests. */
  actions?: SlashAction[];
  query: string;
}

/**
 * Combines OpenCode commands (grouped by source, see `groupCommandsBySource`
 * above) with composer actions (`slash-actions.ts`) into one flat,
 * contiguously-indexed row list — mirrors `buildMentionSections`'s contract
 * for the `@` menu (`menu-items.ts`): one `index` counter threaded across
 * every section in render order, ready for `moveSelection`/`clampSelection`.
 */
export function buildSlashSections({
  commands,
  actions = SLASH_ACTIONS,
  query,
}: BuildSlashSectionsInput): SlashSection[] {
  const q = query.toLowerCase().trim();
  const filteredCommands = q ? commands.filter((c) => commandMatchesQuery(c, q)) : commands;
  const filteredActions = filterSlashActions(actions, query);

  // Render order: Actions, Skills, Commands, MCP.
  //
  // Actions moved from last to first. They are the fixed, always-present rows
  // (switch model, attach a file, …) — the same six every time, in the same
  // place — while the command sections below them change with the project and
  // with what is connected. Putting the stable set at the top is what makes
  // the palette land in a predictable spot instead of one that shifts as
  // skills are added.
  //
  // `index` is assigned in this order and nowhere else: it is a single flat
  // counter threaded across every section, and `MenuNavState`'s ↑/↓ wrapping
  // plus `aria-activedescendant` both read it as "position in the rendered
  // list". Building the sections in a different order to the one they render
  // in would desync the highlight from the keyboard.
  let index = 0;
  const sections: SlashSection[] = [];

  if (filteredActions.length) {
    sections.push({
      heading: 'Actions',
      hideHeading: true,
      rows: filteredActions.map((action) => ({
        index: index++,
        type: 'action' as const,
        name: action.label,
        description: action.description,
        hint: action.hint,
        value: action.value,
        action,
      })),
    });
  }

  for (const group of groupCommandsBySource(filteredCommands)) {
    sections.push({
      heading: group.heading,
      rows: group.commands.map((command) => ({
        index: index++,
        type: 'command' as const,
        name: command.name || '',
        description: command.description || '',
        command,
      })),
    });
  }

  return sections;
}
