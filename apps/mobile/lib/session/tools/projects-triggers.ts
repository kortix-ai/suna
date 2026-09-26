/**
 * Pure logic behind `components/session/tool/tools/triggers-tool.tsx`.
 *
 * Ported from apps/web `tool/tools/triggers-tool.tsx`: the per-action trigger
 * (title, subtitle, icon, args), the `[status] name | source: detail | a → b |
 * last_run: …` line parser, and the create prompt fold. Copy comes from
 * `apps/web/translations/en.json`.
 */

export type TriggerIconKey = 'plus' | 'list' | 'trash' | 'calendar' | 'refresh' | 'monitor' | 'ban';

export interface TriggersRow {
  title: string;
  subtitle: string;
  icon: TriggerIconKey;
  args: string[] | undefined;
}

/** `update` / `test` / `pause` / `resume`: the verb while pending, the past tense once output arrives. */
const PAST_TENSE_ACTIONS: Record<
  'update' | 'test' | 'pause' | 'resume',
  { title: string; pending: string; done: string; icon: TriggerIconKey }
> = {
  update: { title: 'Update Trigger', pending: 'Updating...', done: 'updated', icon: 'refresh' },
  test: { title: 'Test Trigger', pending: 'Testing...', done: 'tested', icon: 'monitor' },
  pause: { title: 'Pause Trigger', pending: 'Pausing...', done: 'paused', icon: 'ban' },
  resume: { title: 'Resume Trigger', pending: 'Resuming...', done: 'resumed', icon: 'refresh' },
};

function s(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function triggersRow(action: string, input: Record<string, unknown>, output: string): TriggersRow {
  switch (action) {
    case 'create': {
      const created = output.match(/Trigger created:\s*(\S+)/)?.[1];
      const sourceType = s(input.source_type);
      return {
        title: 'Create Trigger',
        subtitle: created || s(input.name) || 'Creating...',
        icon: 'plus',
        args: sourceType ? [sourceType] : undefined,
      };
    }
    case 'list': {
      const count = output.match(/TRIGGERS\s*\((\d+)\)/)?.[1];
      return {
        title: 'List Triggers',
        subtitle: count ? `${count} trigger${count === '1' ? '' : 's'}` : output ? 'Loaded' : 'Loading...',
        icon: 'list',
        args: count ? [count] : undefined,
      };
    }
    case 'delete': {
      const id = s(input.trigger_id);
      const deleted = output.toLowerCase().includes('deleted');
      return {
        title: 'Delete Trigger',
        subtitle: deleted ? 'Deleted' : id ? `${id.slice(0, 8)}...` : 'Deleting...',
        icon: 'trash',
        args: deleted ? ['deleted'] : undefined,
      };
    }
    case 'get': {
      const id = s(input.trigger_id) || s(input.name);
      return {
        title: 'Trigger Details',
        subtitle: id ? (id.length > 20 ? `${id.slice(0, 20)}...` : id) : 'Loading...',
        icon: 'calendar',
        args: undefined,
      };
    }
    case 'update':
    case 'test':
    case 'pause':
    case 'resume': {
      const name = s(input.name) || s(input.trigger_id);
      const copy = PAST_TENSE_ACTIONS[action];
      return {
        title: copy.title,
        subtitle: name || copy.pending,
        icon: copy.icon,
        args: output ? [copy.done] : undefined,
      };
    }
    default:
      return { title: 'Triggers', subtitle: action, icon: 'calendar', args: undefined };
  }
}

export { type TriggerLine, parseTriggerLines } from '@kortix/shared/tool-output';

/** Web badge variant: `active` success, `paused` warning, else muted. */
export function triggerStatusTone(status: string): 'success' | 'warning' | 'muted' {
  return status === 'active' ? 'success' : status === 'paused' ? 'warning' : 'muted';
}

export function triggerLoadingMessage(action: string): string {
  return action === 'create' ? 'Creating trigger...' : action === 'delete' ? 'Deleting trigger...' : 'Loading...';
}

/** The prompt a created trigger runs with is its instruction; it folds. */
export const TRIGGER_PROMPT_SECTION = { label: 'Prompt', folded: true } as const;

/** The prompt fold's text (first 400 chars), or `null` when the row has none. */
export function triggerPromptPreview(action: string, input: Record<string, unknown>): string | null {
  if (action !== 'create' || typeof input.prompt !== 'string') return null;
  return input.prompt.slice(0, 400) + (input.prompt.length > 400 ? '...' : '');
}
