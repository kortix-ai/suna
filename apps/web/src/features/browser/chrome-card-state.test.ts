import { describe, expect, test } from 'bun:test';

import { chromeCardState } from './chrome-card-state';

const base = { hasConnectedBrowser: false, environment: 'supported', checking: false, installed: false } as const;

describe('chromeCardState', () => {
  test('not installed: Add to Chrome', () => {
    expect(chromeCardState(base)).toBe('notInstalled');
  });
  test('installed, not connected: Connect', () => {
    expect(chromeCardState({ ...base, installed: true })).toBe('installed');
  });
  test('connected wins, even where the page cannot reach the extension', () => {
    expect(chromeCardState({ ...base, hasConnectedBrowser: true, installed: true })).toBe('connected');
    expect(chromeCardState({ ...base, hasConnectedBrowser: true, environment: 'unsupported' })).toBe('connected');
  });
  test('Safari, Firefox and the desktop shell cannot add it', () => {
    expect(chromeCardState({ ...base, environment: 'unsupported' })).toBe('unsupported');
  });
  test('waits for the first ping before offering the store', () => {
    expect(chromeCardState({ ...base, checking: true })).toBe('checking');
  });
});
