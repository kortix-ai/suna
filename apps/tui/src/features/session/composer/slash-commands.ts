/**
 * The `/` palette's contents, as data.
 *
 * Two sources, one list: the project's own runtime commands (`session.commands`
 * — `ProjectConfigSummary.commands`, served pre-runtime by the control plane)
 * and the TUI's built-ins. A runtime command runs through
 * `session.runCommand(name, args)`; a built-in is either handled inside the
 * composer (the three pickers) or handed to the app through `onCommand`.
 *
 * Pure so the palette can be asserted without a renderer.
 */

import type { ListItem } from '../../../ui/index.ts';

/** A built-in the app owns: the composer just reports it. */
export type AppCommandId = 'new' | 'terminal' | 'files' | 'help' | 'quit' | 'attach' | 'stop';
/** A built-in the composer owns: it opens one of its own pickers. */
export type PickerCommandId = 'model' | 'effort' | 'agent';

export interface BuiltinCommand {
  /** The name after the slash. */
  name: string;
  description: string;
  /** `'app'` calls `onCommand`; `'picker'` opens a composer picker. */
  target: 'app' | 'picker';
}

/**
 * The built-ins, in the order the palette lists them: session actions first,
 * then the three selection pickers, then the app surfaces, then the exits.
 * Mirrors the web composer's slash menu and SPEC §5.3.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'new', description: 'Start a new session', target: 'app' },
  { name: 'model', description: 'Pick the model', target: 'picker' },
  { name: 'effort', description: 'Pick the thinking effort', target: 'picker' },
  { name: 'agent', description: 'Pick the agent', target: 'picker' },
  { name: 'terminal', description: 'Toggle the terminal panel', target: 'app' },
  { name: 'files', description: 'Browse the session files', target: 'app' },
  { name: 'attach', description: 'Attach this session in the opencode TUI', target: 'app' },
  { name: 'help', description: 'Show the keymap', target: 'app' },
  { name: 'quit', description: 'Leave the TUI', target: 'app' },
] as const;

/** The shape `session.commands` carries (`ProjectConfigSummary.commands`). */
export interface RuntimeCommand {
  name: string;
  description?: string | null;
}

/** What the palette does when a row is picked. */
export type CommandAction =
  | { kind: 'runtime'; name: string }
  | { kind: 'app'; id: AppCommandId }
  | { kind: 'picker'; id: PickerCommandId };

const RUNTIME_PREFIX = 'runtime:';
const BUILTIN_PREFIX = 'builtin:';

/**
 * The palette rows.
 *
 * Runtime commands come first — they are the project's own verbs, and the
 * built-ins are always reachable by their own chord. Ids are prefixed because a
 * project is free to define a command called `new`, and two rows sharing one id
 * is a silent selection bug in `List` (selection follows the id).
 *
 * `commands` is defensively normalized: the runtime's `GET /command` has been
 * observed answering with a truthy non-array (see `detect-command.ts` in
 * apps/web), and one bad response must not take the composer down.
 */
export function commandItems(commands: readonly RuntimeCommand[] | undefined): ListItem[] {
  const runtime = Array.isArray(commands) ? commands : [];
  const items: ListItem[] = [];
  for (const command of runtime) {
    if (!command || typeof command.name !== 'string' || !command.name) continue;
    items.push({
      id: `${RUNTIME_PREFIX}${command.name}`,
      label: `/${command.name}`,
      right: command.description ? command.description.slice(0, 40) : 'project',
    });
  }
  for (const builtin of BUILTIN_COMMANDS) {
    items.push({
      id: `${BUILTIN_PREFIX}${builtin.name}`,
      label: `/${builtin.name}`,
      right: builtin.description,
      dim: true,
    });
  }
  return items;
}

/** The action a picked row runs, or null for an id this palette never made. */
export function resolveCommandItem(id: string): CommandAction | null {
  if (id.startsWith(RUNTIME_PREFIX)) {
    const name = id.slice(RUNTIME_PREFIX.length);
    return name ? { kind: 'runtime', name } : null;
  }
  if (!id.startsWith(BUILTIN_PREFIX)) return null;
  const name = id.slice(BUILTIN_PREFIX.length);
  const builtin = BUILTIN_COMMANDS.find((entry) => entry.name === name);
  if (!builtin) return null;
  if (builtin.target === 'picker') return { kind: 'picker', id: name as PickerCommandId };
  return { kind: 'app', id: name as AppCommandId };
}
