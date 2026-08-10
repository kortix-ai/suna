import type { Command } from '@kortix/sdk/react';

import { filterSlashActions, SLASH_ACTIONS, type SlashAction } from './slash-actions';

export interface SlashRow {
  index: number;
  type: 'command' | 'action';
  name: string;
  description: string;
  hint?: string;
  command?: Command;
  action?: SlashAction;
}

export interface SlashSection {
  heading: string;
  rows: SlashRow[];
}

type CommandBucket = 'skill' | 'mcp' | 'command';

const BUCKET_HEADING: Record<CommandBucket, string> = {
  skill: 'Skills',
  mcp: 'MCP',
  command: 'Commands',
};

/** Fixed render order: Skills, then MCP, then plain Commands. */
const BUCKET_ORDER: CommandBucket[] = ['skill', 'mcp', 'command'];

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

  let index = 0;
  const sections: SlashSection[] = groupCommandsBySource(filteredCommands).map((group) => ({
    heading: group.heading,
    rows: group.commands.map((command) => ({
      index: index++,
      type: 'command' as const,
      name: command.name || '',
      description: command.description || '',
      command,
    })),
  }));

  if (filteredActions.length) {
    sections.push({
      heading: 'Actions',
      rows: filteredActions.map((action) => ({
        index: index++,
        type: 'action' as const,
        name: action.label,
        description: action.description,
        hint: action.hint,
        action,
      })),
    });
  }

  return sections;
}
