export type SlashActionId =
  | 'switch-model'
  | 'switch-agent'
  | 'set-reasoning-effort'
  | 'attach-file'
  | 'start-voice';

export interface SlashAction {
  id: SlashActionId;
  label: string;
  /** Also searched, so "thinking" finds reasoning effort. */
  description: string;
  /** Shown right-aligned when the action has a shortcut. */
  hint?: string;
  /**
   * The control's CURRENT setting, shown right-aligned before `hint`.
   *
   * `SLASH_ACTIONS` below is a static list and cannot know it — this is
   * filled in by the host, which does (`composer.tsx` passes an `actions`
   * list derived from `selectedAgent`). Deliberately not part of the search
   * text: `filterSlashActions` matches label and description only, so typing
   * an agent's name does not make an unrelated "Switch agent" row appear
   * above the agent-mention results.
   */
  value?: string;
}

/**
 * Composer operations, executed locally. These never reach the agent — they
 * open the control they name. Distinct from the Commands section, which runs
 * real OpenCode commands through `session.command()`.
 */
export const SLASH_ACTIONS: SlashAction[] = [
  {
    id: 'switch-model',
    label: 'Switch model',
    description: 'Choose which model runs this turn',
  },
  {
    id: 'switch-agent',
    label: 'Switch agent',
    description: 'Choose which agent answers',
    hint: 'Tab',
  },
  {
    id: 'set-reasoning-effort',
    label: 'Set reasoning effort',
    description: 'How much thinking the model does before answering',
  },
  { id: 'attach-file', label: 'Attach file', description: 'Add an image or document' },
  {
    id: 'start-voice',
    label: 'Start voice input',
    description: 'Dictate the message with your microphone',
  },
];

/*
 * `set-scope` used to be a sixth row here. It was REMOVED, not forgotten: no
 * scope panel exists for it to open, so `handleSelectAction` fell to its
 * `default: return` and the row highlighted, offered a "Use" button, and did
 * nothing. Re-add it only together with the control it names.
 */

/** A composer control a `/` row can open. */
export type SlashActionControl = 'model' | 'reasoning';

/**
 * Which toolbar control a `/` row opens, or `null` for the rows that open
 * nothing.
 *
 * These used to be one control: reasoning effort was a footer row inside the
 * model popover, so both rows opened the same element and differed only in
 * where focus landed. Reasoning effort is now its own dropdown
 * (`reasoning-effort-selector.tsx`), so they are genuinely two targets and
 * this returns which one.
 *
 * Pure and exported so it is testable: `composer.tsx`'s `handleSelectAction`
 * is inside a `React.lazy`-boundary client component, and this repo's
 * `bun test` has no DOM, so a mapping left inline there could not be asserted
 * at all.
 */
export function controlToOpenFor(id: SlashActionId): SlashActionControl | null {
  if (id === 'switch-model') return 'model';
  if (id === 'set-reasoning-effort') return 'reasoning';
  return null;
}

export function filterSlashActions(actions: SlashAction[], query: string): SlashAction[] {
  const q = query.toLowerCase().trim();
  if (!q) return actions;
  return actions.filter(
    (a) => a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
  );
}
