export type SlashActionId =
  | 'switch-model'
  | 'switch-agent'
  | 'set-reasoning-effort'
  | 'attach-file'
  | 'start-voice'
  | 'set-scope';

export interface SlashAction {
  id: SlashActionId;
  label: string;
  /** Also searched, so "thinking" finds reasoning effort. */
  description: string;
  /** Shown right-aligned when the action has a shortcut. */
  hint?: string;
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
  { id: 'start-voice', label: 'Start voice input', description: 'Dictate instead of typing' },
  { id: 'set-scope', label: 'Set scope', description: 'Limit which files this session may touch' },
];

export function filterSlashActions(actions: SlashAction[], query: string): SlashAction[] {
  const q = query.toLowerCase().trim();
  if (!q) return actions;
  return actions.filter(
    (a) => a.label.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
  );
}
