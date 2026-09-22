import { describe, expect, test } from 'bun:test';

import {
  cleanWorkerOutput,
  extractWorkerPreview,
  isShortOutput,
  parseTaskRows,
} from './agent-helpers';

describe('agent helpers', () => {
  test('cleanWorkerOutput strips the worker envelope and keeps the result', () => {
    const raw = [
      '## Worker Result',
      '**Agent:** builder',
      '**Task:** ship it',
      '---',
      'Did the thing.',
      'Worker session: ses_abc123',
    ].join('\n');
    expect(cleanWorkerOutput(raw)).toBe('Did the thing.');
    expect(cleanWorkerOutput('')).toBe('');
  });

  test('cleanWorkerOutput drops goal-system blocks and task receipts', () => {
    const raw =
      '<kortix_goal_system id="1">secret</kortix_goal_system>\nTask **task-ab12** created and started. ok\nAll good';
    expect(cleanWorkerOutput(raw)).toBe('All good');
  });

  test('isShortOutput is three non-empty lines or fewer', () => {
    expect(isShortOutput('a\nb\n\nc')).toBe(true);
    expect(isShortOutput('a\nb\nc\nd')).toBe(false);
    expect(isShortOutput('')).toBe(false);
  });

  test('extractWorkerPreview takes the first prose line without its bold lead', () => {
    expect(extractWorkerPreview('# Title\n**Done** Built the API')).toBe('Built the API');
    expect(extractWorkerPreview('a'.repeat(130))).toBe(`${'a'.repeat(120)}…`);
    expect(extractWorkerPreview('')).toBeNull();
  });

  test('parseTaskRows reads id, title, status and session', () => {
    expect(parseTaskRows('- **task-ab12** Fix login — running (ses_XyZ9)\nnoise')).toEqual([
      { id: 'task-ab12', title: 'Fix login', status: 'running', sessionId: 'ses_XyZ9' },
    ]);
    expect(parseTaskRows('')).toEqual([]);
  });
});
