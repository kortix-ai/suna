/**
 * Every slash command the TUI answers to, as data.
 *
 * The TUI is session-first: one session fills the screen and every action is
 * reachable from its input by typing `/`. This table is the one list of those
 * actions. The slash menu ranks it, the help overlay prints it, and
 * `app.tsx`'s `runCommand` switches on `CommandName` — an exhaustive switch, so
 * a row with no handler is a type error, not a dead menu entry.
 *
 * A row may name a keymap binding (`binding`). That chord is an accelerator for
 * the same command: the menu prints it beside the description, so the chords
 * are discoverable from the input too.
 *
 * Pure: no React, no SDK client. `registry.test.ts` asserts the ranking, the
 * parsing and the availability rules directly.
 */

import { type RuntimeCapability, runtimeSupports } from '@kortix/sdk';

export type CommandGroup = 'session' | 'switch' | 'selection' | 'view' | 'screen' | 'app';

export const GROUP_TITLE: Record<CommandGroup, string> = {
  session: 'Session',
  switch: 'Switch',
  selection: 'Model and agent',
  view: 'Panels',
  screen: 'Screens',
  app: 'App',
};

/** What a command needs before it can run. */
export type CommandNeed = 'project' | 'session' | 'account';

export interface CommandSpec {
  /** The word after the slash. Unique across names and aliases. */
  name: string;
  /** Other words that run the same command. */
  aliases?: readonly string[];
  /** Argument hint printed after the name, e.g. `<title>`. Optional args in `[ ]`. */
  args?: string;
  /** Imperative, one line. */
  description: string;
  group: CommandGroup;
  /** A keymap binding id whose chord runs the same command. */
  binding?: string;
  needs?: CommandNeed;
  /** A runtime capability (`GET /kortix/health`) the command needs. */
  capability?: RuntimeCapability;
  /** A project feature flag (`useFeatureFlag`) the command needs. */
  flag?: string;
}

/**
 * The commands, in menu order: what you do to the open session first, then
 * where you go, then what you pick, then what you show.
 */
export const COMMANDS = [
  // — session —
  {
    name: 'new',
    aliases: ['clear'],
    args: '[prompt]',
    description: 'Start a new session. A prompt after the name is its first message.',
    group: 'session',
    binding: 'session.new',
    needs: 'project',
  },
  {
    name: 'sessions',
    aliases: ['resume', 'continue', 'switch'],
    args: '[filter]',
    description: 'Pick a session of this project and open it.',
    group: 'session',
    binding: 'switcher',
    needs: 'project',
  },
  {
    name: 'rename',
    args: '<title>',
    description: 'Rename this session.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'stop',
    description: 'Stop the running turn.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'compact',
    description: 'Summarize the conversation to free context.',
    group: 'session',
    needs: 'session',
    capability: 'session.compact',
  },
  {
    name: 'restart',
    description: "Restart this session's sandbox. The conversation is kept.",
    group: 'session',
    needs: 'session',
  },
  {
    name: 'close',
    description: 'Close this session tab; the neighbour opens.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'fork',
    args: '[prompt]',
    description: 'Copy this conversation into a new session and open it.',
    group: 'session',
    needs: 'session',
    capability: 'session.fork',
  },
  {
    name: 'pin',
    description: 'Pin or unpin this session at the top of the list.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'archive',
    description: 'Archive this session, or bring it back.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'share',
    args: '<team|private>',
    description: 'Let the whole project open this session, or only you.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'reload',
    description: 'Reload kortix.yaml, agents and skills into this session.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'copy',
    description: 'Copy the last reply to the clipboard.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'link',
    aliases: ['id'],
    description: 'Copy the session id and its web link.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'export',
    args: '[file]',
    description: 'Save the conversation as Markdown in the current folder.',
    group: 'session',
    needs: 'session',
  },
  {
    name: 'delete',
    description: 'Delete this session. Asks first.',
    group: 'session',
    needs: 'session',
  },
  // — switch —
  {
    name: 'projects',
    aliases: ['project'],
    args: '[filter]',
    description: 'Pick another project.',
    group: 'switch',
  },
  {
    name: 'accounts',
    aliases: ['org'],
    args: '[filter]',
    description: 'Pick another account.',
    group: 'switch',
  },
  {
    name: 'hosts',
    aliases: ['host', 'login'],
    description: 'Switch host or log in to another one.',
    group: 'switch',
    binding: 'hosts',
  },
  {
    name: 'logout',
    description: "Remove this host's token, then show the login screen.",
    group: 'switch',
  },
  // — model and agent —
  {
    name: 'model',
    aliases: ['models'],
    description: 'Pick the model.',
    group: 'selection',
    binding: 'composer.model',
    needs: 'session',
  },
  {
    name: 'effort',
    aliases: ['thinking'],
    description: 'Pick the thinking effort.',
    group: 'selection',
    binding: 'composer.effort',
    needs: 'session',
  },
  {
    name: 'agent',
    aliases: ['agents'],
    description: 'Pick the agent.',
    group: 'selection',
    binding: 'composer.agent',
    needs: 'session',
  },
  // — panels —
  {
    name: 'ui',
    aliases: ['layout', 'tui'],
    description: 'Pick the layout: presets, and every panel on or off, left or right.',
    group: 'view',
  },
  {
    name: 'sidebar',
    description: 'Show or hide the sidebar. The choice is remembered.',
    group: 'view',
    binding: 'panel.sidebar',
  },
  {
    name: 'info',
    aliases: ['panel'],
    description: 'Show or hide the info panel: title, context, model, ports.',
    group: 'view',
    binding: 'panel.info',
  },
  {
    name: 'tabs',
    description: 'Show or hide the session tabs.',
    group: 'view',
  },
  {
    name: 'header',
    aliases: ['titlebar'],
    description: 'Show or hide the title row above the transcript.',
    group: 'view',
  },
  {
    name: 'tray',
    aliases: ['statusline'],
    description: 'Show or hide the row under the input.',
    group: 'view',
  },
  {
    name: 'title',
    description: "Let the terminal window's title follow the session, or not.",
    group: 'view',
  },
  {
    name: 'terminal',
    aliases: ['shell'],
    description: "Open or close a shell in this session's sandbox.",
    group: 'view',
    binding: 'panel.terminal',
    needs: 'session',
  },
  {
    name: 'ports',
    description: 'Forward sandbox ports to this machine.',
    group: 'view',
    binding: 'ports',
    needs: 'session',
  },
  {
    name: 'links',
    description: 'Open a URL from the transcript or the terminal.',
    group: 'view',
    binding: 'links',
    needs: 'session',
  },
  // — screens —
  {
    name: 'files',
    description: "Browse this session's files.",
    group: 'screen',
    binding: 'screen.files',
    needs: 'session',
  },
  {
    name: 'drive',
    aliases: ['volumes'],
    description: 'Project files on Drive: yours, shared, team folders.',
    group: 'screen',
    needs: 'project',
    flag: 'drives',
  },
  {
    name: 'repo',
    aliases: ['git', 'code'],
    description: "Browse the project's repository: files, branches, history.",
    group: 'screen',
    needs: 'project',
  },
  {
    name: 'artifacts',
    aliases: ['docs'],
    description: 'Docs and pages the agents published.',
    group: 'screen',
    needs: 'project',
    flag: 'artifacts',
  },
  {
    name: 'inbox',
    aliases: ['notifications'],
    description: 'Notifications: what needs you, newest first.',
    group: 'screen',
  },
  {
    name: 'approvals',
    aliases: ['permissions', 'decisions', 'outputs'],
    description: 'Approvals, outputs and decisions waiting on a person.',
    group: 'screen',
    needs: 'project',
  },
  {
    name: 'goals',
    description: 'Outcomes the agents work toward, and their progress.',
    group: 'screen',
    needs: 'project',
    flag: 'goals',
  },
  {
    name: 'memory',
    aliases: ['knowledge'],
    description: 'Read and search company memory pages.',
    group: 'screen',
    needs: 'project',
    flag: 'project_channels',
  },
  {
    name: 'spaces',
    aliases: ['channels', 'dm'],
    description: 'Channels and DMs, and the threads in them.',
    group: 'screen',
    needs: 'project',
    flag: 'project_channels',
  },
  {
    name: 'rooms',
    description: 'Rooms where agents and people talk.',
    group: 'screen',
    needs: 'project',
    flag: 'agent_rooms',
  },
  {
    name: 'loops',
    aliases: ['reminders', 'schedule'],
    description: "This session's loops: prompts that run on a schedule.",
    group: 'screen',
    needs: 'session',
    flag: 'reminders',
  },
  {
    name: 'audit',
    aliases: ['activity'],
    description: 'What happened in this session, and approvals waiting.',
    group: 'screen',
    needs: 'session',
  },
  {
    name: 'review',
    aliases: ['changes', 'pr-comments'],
    description: 'Review change requests.',
    group: 'screen',
    binding: 'screen.review',
    needs: 'project',
  },
  {
    name: 'apps',
    description: 'List and deploy Apps.',
    group: 'screen',
    binding: 'screen.apps',
  },
  {
    name: 'customize',
    aliases: ['settings', 'config', 'mcp', 'connectors'],
    description: 'Agents, skills, secrets, triggers, connectors.',
    group: 'screen',
    binding: 'screen.customize',
  },
  {
    name: 'account',
    aliases: ['members', 'billing', 'usage'],
    description: 'Members, invites, roles, credits.',
    group: 'screen',
    binding: 'screen.account',
    needs: 'account',
  },
  // — app —
  {
    name: 'status',
    aliases: ['doctor', 'whoami'],
    description: 'Host, account, project, session, runtime and version.',
    group: 'app',
  },
  {
    name: 'feedback',
    aliases: ['bug'],
    description: 'Report a bug or an idea on GitHub.',
    group: 'app',
  },
  {
    name: 'help',
    aliases: ['keys', '?'],
    description: 'Show every command and key.',
    group: 'app',
    binding: 'help',
  },
  {
    name: 'quit',
    aliases: ['exit', 'q'],
    description: 'Leave the TUI.',
    group: 'app',
    binding: 'quit',
  },
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof COMMANDS)[number]['name'];

/** What the open screen can offer right now. */
export interface CommandContext {
  hasProject: boolean;
  hasSession: boolean;
  hasAccount: boolean;
  /** The runtime's `/kortix/health` capabilities. Null = not read yet: hide nothing. */
  capabilities: readonly string[] | null;
  /** Project feature flags by key. A key that is absent is not known yet: allow. */
  flags?: Readonly<Record<string, boolean>>;
}

/**
 * Why `spec` cannot run here, or null when it can.
 *
 * The menu still lists an unavailable command, dimmed, with this reason — a
 * command that silently vanishes reads as a missing feature.
 */
export function unavailableReason(spec: CommandSpec, context: CommandContext): string | null {
  if (spec.needs === 'session' && !context.hasSession) return 'needs an open session';
  if (spec.needs === 'project' && !context.hasProject) return 'needs a project — /projects';
  if (spec.needs === 'account' && !context.hasAccount) return 'needs an account — /accounts';
  if (
    spec.capability &&
    context.hasSession &&
    !runtimeSupports(context.capabilities, spec.capability)
  ) {
    return "this session's runtime does not support it";
  }
  if (spec.flag && context.flags?.[spec.flag] === false) return 'turned off for this project';
  return null;
}

/** A `/name args` line, split. Null when the text is not one slash command line. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/') || trimmed.includes('\n')) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { name: body.toLowerCase(), args: '' };
  return { name: body.slice(0, space).toLowerCase(), args: body.slice(space + 1).trim() };
}

/** The spec a typed word names, by name or alias. Exact, case-insensitive. */
export function findCommand<T extends CommandSpec>(
  word: string,
  commands: readonly T[] = COMMANDS as unknown as readonly T[],
): T | null {
  const needle = word.toLowerCase();
  if (!needle) return null;
  return (
    commands.find((spec) => spec.name === needle) ??
    commands.find((spec) => spec.aliases?.includes(needle)) ??
    null
  );
}

/**
 * How well `word` matches `query`, higher is better, 0 = no match.
 *
 * Prefix beats substring beats subsequence, so `/se` ranks `sessions` above
 * `rename`, and `/ss` still finds `sessions`.
 */
export function matchScore(word: string, query: string): number {
  const w = word.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (w === q) return 100;
  if (w.startsWith(q)) return 80 - Math.min(w.length - q.length, 20);
  const at = w.indexOf(q);
  if (at > 0) return 40 - Math.min(at, 20);
  let position = 0;
  for (const char of q) {
    position = w.indexOf(char, position);
    if (position < 0) return 0;
    position += 1;
  }
  return 10;
}

/** The band a `matchScore` falls in: 3 exact, 2 prefix, 1 substring, 0 subsequence. */
export function matchTier(score: number): number {
  if (score >= 100) return 3;
  if (score >= 60) return 2;
  if (score >= 20) return 1;
  return 0;
}

/** One menu row: a built-in or one of the project's own runtime commands. */
export interface MenuEntry {
  name: string;
  args?: string;
  description: string;
  /** `builtin` runs through `runCommand`; `runtime` through `session.runCommand`. */
  source: 'builtin' | 'runtime';
  group: CommandGroup | 'project';
  binding?: string;
  /** Set when it cannot run here; the row is dimmed and Enter shows this. */
  unavailable: string | null;
}

/** The shape `session.commands` carries (`ProjectConfigSummary.commands`). */
export interface RuntimeCommand {
  name: string;
  description?: string | null;
}

/**
 * The rows the slash menu shows for `query` (the word after `/`).
 *
 * Empty query: every built-in in table order, then the project's commands.
 * Otherwise ranked by `matchScore` over the name and aliases; ties keep table
 * order. Available rows rank above unavailable ones with the same score.
 *
 * `runtime` is defensively normalized: the runtime's command list has been
 * observed answering with a truthy non-array, and one bad response must not
 * take the input down.
 */
export function menuEntries(
  query: string,
  context: CommandContext,
  runtime: readonly RuntimeCommand[] | undefined = [],
): MenuEntry[] {
  const entries: { entry: MenuEntry; score: number; order: number }[] = [];
  let order = 0;
  for (const spec of COMMANDS as readonly CommandSpec[]) {
    const words = [spec.name, ...(spec.aliases ?? [])];
    const score = Math.max(...words.map((word) => matchScore(word, query)));
    order += 1;
    if (score === 0) continue;
    entries.push({
      score,
      order,
      entry: {
        name: spec.name,
        args: spec.args,
        description: spec.description,
        source: 'builtin',
        group: spec.group,
        binding: spec.binding,
        unavailable: unavailableReason(spec, context),
      },
    });
  }
  const project =
    Array.isArray(runtime) && runtimeSupports(context.capabilities, 'session.commands')
      ? runtime
      : [];
  for (const command of project) {
    if (!command || typeof command.name !== 'string' || !command.name) continue;
    // A project command never shadows a built-in: the built-in row is the one
    // the name runs, so a second row with the same name would lie.
    if (findCommand(command.name)) continue;
    const score = matchScore(command.name, query);
    order += 1;
    if (score === 0) continue;
    entries.push({
      score,
      order,
      entry: {
        name: command.name,
        description: command.description?.trim() || 'Project command',
        source: 'runtime',
        group: 'project',
        unavailable: null,
      },
    });
  }
  // Empty query: table order, but what can run here first — with no session
  // open, the list must not open on six dimmed session commands.
  if (!query) {
    return entries
      .sort((a, b) => {
        const ua = a.entry.unavailable ? 1 : 0;
        const ub = b.entry.unavailable ? 1 : 0;
        return ua - ub || a.order - b.order;
      })
      .map((row) => row.entry);
  }
  return entries
    .sort((a, b) => {
      // Tier first (exact, prefix, substring, subsequence), then what can run
      // here, then the finer score: with no session open, `/s` offers
      // `sessions` before `stop`.
      const tier = matchTier(b.score) - matchTier(a.score);
      if (tier !== 0) return tier;
      const ua = a.entry.unavailable ? 1 : 0;
      const ub = b.entry.unavailable ? 1 : 0;
      if (ua !== ub) return ua - ub;
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    })
    .map((row) => row.entry);
}
