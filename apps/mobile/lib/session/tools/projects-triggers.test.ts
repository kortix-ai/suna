import { describe, expect, test } from 'bun:test';
import {
  TRIGGER_PROMPT_SECTION,
  parseTriggerLines,
  triggerLoadingMessage,
  triggerPromptPreview,
  triggerStatusTone,
  triggersRow,
} from './projects-triggers';

// Port of apps/web `triggers-tool.test.tsx` (Task 20): creating a trigger
// answers with the trigger. The prompt it will run with is a paragraph of
// instructions and folds.

const CREATE_INPUT = {
  action: 'create',
  name: 'daily-standup',
  source_type: 'cron',
  prompt: 'Summarize what the team shipped yesterday and post it to Slack.',
};
const CREATE_OUTPUT =
  'Trigger created: daily-standup\n[active] daily-standup | cron: 0 9 * * * | kortix → kortix | last_run: never';

describe('TriggersTool', () => {
  test('the trigger row stays visible; its prompt folds', () => {
    expect(parseTriggerLines(CREATE_OUTPUT)).toEqual([
      {
        status: 'active',
        name: 'daily-standup',
        sourceType: 'cron',
        sourceDetail: '0 9 * * *',
        agent: 'kortix',
        lastRun: 'never',
      },
    ]);
    expect(triggerStatusTone('active')).toBe('success');
    expect(TRIGGER_PROMPT_SECTION).toEqual({ label: 'Prompt', folded: true });
    expect(triggerPromptPreview('create', CREATE_INPUT)).toBe(CREATE_INPUT.prompt);
  });

  test('the create trigger names the created trigger and its source type', () => {
    expect(triggersRow('create', CREATE_INPUT, CREATE_OUTPUT)).toEqual({
      title: 'Create Trigger',
      subtitle: 'daily-standup',
      icon: 'plus',
      args: ['cron'],
    });
    expect(triggersRow('create', {}, '').subtitle).toBe('Creating...');
  });

  test('a long prompt is cut at 400 characters; a non-create action has no prompt fold', () => {
    const long = 'p'.repeat(450);
    expect(triggerPromptPreview('create', { prompt: long })).toBe(`${'p'.repeat(400)}...`);
    expect(triggerPromptPreview('update', { prompt: 'x' })).toBeNull();
    expect(triggerPromptPreview('create', { prompt: 3 })).toBeNull();
  });
});

describe('triggersRow per action (web copy)', () => {
  test('list', () => {
    expect(triggersRow('list', {}, 'TRIGGERS (1)\n[paused] a | webhook: /hook | x → y | last_run: 2026')).toEqual({
      title: 'List Triggers',
      subtitle: '1 trigger',
      icon: 'list',
      args: ['1'],
    });
    expect(triggersRow('list', {}, 'TRIGGERS (3)').subtitle).toBe('3 triggers');
    expect(triggersRow('list', {}, 'something').subtitle).toBe('Loaded');
    expect(triggersRow('list', {}, '').subtitle).toBe('Loading...');
  });

  test('delete / get', () => {
    expect(triggersRow('delete', { trigger_id: 'abcdef123456' }, '')).toEqual({
      title: 'Delete Trigger',
      subtitle: 'abcdef12...',
      icon: 'trash',
      args: undefined,
    });
    expect(triggersRow('delete', {}, 'Trigger deleted')).toMatchObject({ subtitle: 'Deleted', args: ['deleted'] });
    expect(triggersRow('get', { trigger_id: 'x'.repeat(25) }, '')).toEqual({
      title: 'Trigger Details',
      subtitle: `${'x'.repeat(20)}...`,
      icon: 'calendar',
      args: undefined,
    });
  });

  test('update / test / pause / resume carry a past-tense arg once output arrives', () => {
    expect(triggersRow('update', { name: 'n' }, 'ok')).toEqual({ title: 'Update Trigger', subtitle: 'n', icon: 'refresh', args: ['updated'] });
    expect(triggersRow('test', {}, '')).toEqual({ title: 'Test Trigger', subtitle: 'Testing...', icon: 'monitor', args: undefined });
    expect(triggersRow('pause', { trigger_id: 't' }, 'ok')).toEqual({ title: 'Pause Trigger', subtitle: 't', icon: 'ban', args: ['paused'] });
    expect(triggersRow('resume', {}, 'ok')).toEqual({ title: 'Resume Trigger', subtitle: 'Resuming...', icon: 'refresh', args: ['resumed'] });
  });

  test('an unknown action is "Triggers" with the action as its subtitle', () => {
    expect(triggersRow('explode', {}, '')).toEqual({ title: 'Triggers', subtitle: 'explode', icon: 'calendar', args: undefined });
  });

  test('unparseable bracket lines are kept raw; tones and loading copy', () => {
    expect(parseTriggerLines('[weird line')).toEqual([{ raw: '[weird line' }]);
    expect(parseTriggerLines('')).toEqual([]);
    expect(triggerStatusTone('paused')).toBe('warning');
    expect(triggerStatusTone('disabled')).toBe('muted');
    expect(triggerLoadingMessage('create')).toBe('Creating trigger...');
    expect(triggerLoadingMessage('delete')).toBe('Deleting trigger...');
    expect(triggerLoadingMessage('list')).toBe('Loading...');
  });
});
