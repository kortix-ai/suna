import { describe, expect, test } from 'bun:test';
import { planComposerSend } from './send-plan';

const base = { text: '', fileCount: 0, disabled: false, isBusy: false, canQueue: true, canAttach: true };

describe('planComposerSend', () => {
  test('image only while idle sends', () => {
    expect(planComposerSend({ ...base, text: '', fileCount: 1 })).toBe('send');
  });

  test('image while busy is refused, not queued', () => {
    expect(planComposerSend({ ...base, fileCount: 1, isBusy: true })).toBe('refuse-busy-files');
    expect(planComposerSend({ ...base, text: 'look', fileCount: 1, isBusy: true })).toBe('refuse-busy-files');
  });

  test('text while busy queues', () => {
    expect(planComposerSend({ ...base, text: 'next', isBusy: true })).toBe('queue');
  });

  test('empty text and no files is a noop', () => {
    expect(planComposerSend({ ...base, text: '   ' })).toBe('noop');
  });

  test('disabled is a noop even with files', () => {
    expect(planComposerSend({ ...base, text: 'hi', fileCount: 2, disabled: true })).toBe('noop');
  });

  test('files without a project session are refused', () => {
    expect(planComposerSend({ ...base, fileCount: 1, canAttach: false })).toBe('refuse-no-session');
  });

  test('text while busy without a queue handler sends', () => {
    expect(planComposerSend({ ...base, text: 'now', isBusy: true, canQueue: false })).toBe('send');
  });

  test('text while idle sends', () => {
    expect(planComposerSend({ ...base, text: 'hello' })).toBe('send');
  });
});
