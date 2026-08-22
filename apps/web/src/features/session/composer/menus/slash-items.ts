import type { Command } from '@kortix/sdk/react';

import { filterSlashActions, SLASH_ACTIONS, type SlashAction } from './slash-actions';
import { filterSlashFiles, type SlashFile } from './slash-files';

export interface SlashRow {
  index: number;
  type: 'command' | 'action' | 'file';
  name: string;
  description: string;
  hint?: string;
  /**
   * Trailing muted text, right-aligned before `hint`. An action row puts its
   * current setting here (see `SlashAction.value`); a file row puts its
   * folder, which is what tells two `index.ts` rows apart.
   */
  value?: string;
  command?: Command;
  action?: SlashAction;
  /** Set only on a `file` row — the file the row inserts a mention for. */
  file?: SlashFile;
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

/** Heading for the files the agent MADE — the Outputs card's own word. */
const OUTPUTS_HEADING = 'Outputs';

/** Heading for the files the agent READ — the Context card's own word. */
const CONTEXT_HEADING = 'Context';

/**
 * File rows per section once a query narrows the list.
 *
 * Matches the `@` menu's own `FILE_LIMIT` (`menu-items.ts`) so the two
 * palettes cannot disagree about how many files a search is worth.
 */
const FILE_LIMIT = 20;

/**
 * File rows per section on a bare `/`, before anything is typed.
 *
 * Lower than `FILE_LIMIT` on purpose. A long session produces dozens of
 * files, and listing all of them above Skills/Commands would bury every
 * command behind a scroll — the palette's fixed rows are what make it land in
 * a predictable place. Six is enough to show that the session's files ARE
 * here; typing one character lifts the cap to `FILE_LIMIT` and reaches the
 * rest.
 */
const FILE_PREVIEW_LIMIT = 6;

export interface BuildSlashSectionsInput {
  commands: Command[];
  /** Defaults to `SLASH_ACTIONS`; overridable for tests. */
  actions?: SlashAction[];
  /**
   * The session's own files — what the Outputs and Context cards show, via
   * `sessionSlashFiles` (`slash-files.ts`). Omitted outside a session (the
   * marketing composer, the project-home composer), where there is no panel
   * and therefore no files.
   */
  files?: SlashFile[];
  query: string;
}

/**
 * Combines OpenCode commands (grouped by source, see `groupCommandsBySource`
 * above) with composer actions (`slash-actions.ts`) and the session's own
 * files (`slash-files.ts`) into one flat, contiguously-indexed row list —
 * mirrors `buildMentionSections`'s contract for the `@` menu
 * (`menu-items.ts`): one `index` counter threaded across every section in
 * render order, ready for `moveSelection`/`clampSelection`.
 */
export function buildSlashSections({
  commands,
  actions = SLASH_ACTIONS,
  files = [],
  query,
}: BuildSlashSectionsInput): SlashSection[] {
  const q = query.toLowerCase().trim();
  const filteredCommands = q ? commands.filter((c) => commandMatchesQuery(c, q)) : commands;
  const filteredActions = filterSlashActions(actions, query);
  const filteredFiles = filterSlashFiles(files, query);
  const fileCap = q ? FILE_LIMIT : FILE_PREVIEW_LIMIT;

  // Render order: Actions, Outputs, Context, Skills, Commands, MCP.
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

  // Outputs, then Context, then the command buckets.
  //
  // Above the commands because this is the one part of the palette that is
  // about THIS session: the file the agent just wrote is the thing a user
  // reaches for to say "now do X with it", and it must not sit below a
  // scrolling list of skills. Below Actions because Actions are the fixed
  // rows the palette's muscle memory is built on.
  for (const origin of ['output', 'context'] as const) {
    const rows = filteredFiles.filter((f) => f.origin === origin).slice(0, fileCap);
    if (!rows.length) continue;
    sections.push({
      heading: origin === 'output' ? OUTPUTS_HEADING : CONTEXT_HEADING,
      rows: rows.map((file) => ({
        index: index++,
        type: 'file' as const,
        name: file.name,
        // The full path, so the detail pane answers "which file is this?"
        // for a row whose name is a title or a repeated basename.
        description: file.path,
        value: file.folder || undefined,
        file,
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
