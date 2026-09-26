import { describe, expect, test } from 'bun:test';

import {
  agentMessageModel,
  agentStatusModel,
  agentStopModel,
  agentTaskUpdateRoute,
  shortAgentId,
} from './agents-status';

// Ported from apps/web tool/tools/agent-status-tool.test.tsx (the representative
// test for the agent + task family), asserted on the model the row draws.

const OUTPUT = [
  '**task-abc12345** Write the report — completed',
  '**task-def67890** Fix the failing test — in_progress ses_worker42',
].join('\n');

describe('agentStatusModel', () => {
  test('parses one row per task, with the worker session when the line names one', () => {
    const model = agentStatusModel({ status: 'completed', output: OUTPUT });
    expect(model.title).toBe('Agent status');
    expect(model.taskRows).toEqual([
      { id: 'task-abc12345', title: 'Write the report', status: 'completed', sessionId: undefined },
      { id: 'task-def67890', title: 'Fix the failing test', status: 'in_progress', sessionId: 'ses_worker42' },
    ]);
    expect(model.badge).toBe('2 tasks');
    expect(model.showRows).toBe(true);
    expect(model.showError).toBe(false);
    expect(model.showRaw).toBe(false);
  });

  test('one task → singular badge', () => {
    const model = agentStatusModel({ status: 'completed', output: '**task-abc12345** Only — completed' });
    expect(model.badge).toBe('1 task');
  });

  test('while running nothing renders and no badge is counted', () => {
    const model = agentStatusModel({ status: 'running', output: OUTPUT });
    expect(model.badge).toBeUndefined();
    expect(model.showRows).toBe(false);
    expect(model.showError).toBe(false);
    expect(model.showRaw).toBe(false);
  });

  test('no task rows → the cleaned output', () => {
    const model = agentStatusModel({ status: 'completed', output: '## Worker Result\nAll quiet.' });
    expect(model.showRows).toBe(false);
    expect(model.showRaw).toBe(true);
    expect(model.cleanedOutput).toBe('All quiet.');
  });

  test('an error payload → the fallback, never the raw block', () => {
    const model = agentStatusModel({ status: 'completed', output: '{"success":false,"error":"nope"}' });
    expect(model.showError).toBe(true);
    expect(model.showRaw).toBe(false);
  });
});

describe('agentMessageModel', () => {
  test('subtitle is the last 12 characters of the task id; body is the message', () => {
    const model = agentMessageModel({
      status: 'completed',
      input: { id: 'task-0123456789abcdef', message: 'Keep going' },
      output: 'Message sent to task',
    });
    expect(model.title).toBe('Message agent');
    expect(model.subtitle).toBe('456789abcdef');
    expect(model.args).toBeUndefined();
    expect(model.rawMessage).toBe('Keep going');
    expect(model.sessionTitle).toBe('Message → task-0123456789abcdef');
  });

  test('failed call → args ["failed"]; no id → worker title', () => {
    const model = agentMessageModel({ status: 'error', input: {}, output: '' });
    expect(model.isError).toBe(true);
    expect(model.args).toEqual(['failed']);
    expect(model.subtitle).toBeUndefined();
    expect(model.sessionTitle).toBe('Message → worker');
  });

  test('agent_id is the fallback id', () => {
    expect(agentMessageModel({ status: 'completed', input: { agent_id: 'a1' }, output: '' }).subtitle).toBe('a1');
  });
});

describe('agentStopModel / agentTaskUpdateRoute', () => {
  test('stop: title, short agent id, "stopped"', () => {
    expect(agentStopModel({ agent_id: 'agent-0123456789abcdef' })).toEqual({
      title: 'Stop agent',
      subtitle: '456789abcdef',
      args: ['stopped'],
    });
    expect(agentStopModel({}).subtitle).toBeUndefined();
  });

  test('update routes by action; anything else is a message', () => {
    expect(agentTaskUpdateRoute({ action: 'start' })).toBe('start');
    expect(agentTaskUpdateRoute({ action: 'message' })).toBe('message');
    expect(agentTaskUpdateRoute({ action: 'cancel' })).toBe('cancel');
    expect(agentTaskUpdateRoute({ action: 'approve' })).toBe('approve');
    expect(agentTaskUpdateRoute({ action: 'bogus' })).toBe('message');
    expect(agentTaskUpdateRoute({})).toBe('message');
  });

  test('shortAgentId keeps the last 12 characters', () => {
    expect(shortAgentId('abc')).toBe('abc');
    expect(shortAgentId('')).toBeUndefined();
  });
});
