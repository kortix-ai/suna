import { describe, expect, test } from 'bun:test';

import { chromeCardState } from './chrome-card-state';

const base = { thisBrowserConnected: false, environment: 'supported', checking: false, installed: false } as const;

describe('chromeCardState', () => {
  test('not installed: install steps', () => {
    expect(chromeCardState(base)).toBe('notInstalled');
  });
  test('installed, not connected: Connect', () => {
    expect(chromeCardState({ ...base, installed: true })).toBe('installed');
  });
  test('this browser connected wins, even where the page cannot reach the extension', () => {
    expect(chromeCardState({ ...base, thisBrowserConnected: true, installed: true })).toBe('connected');
    expect(chromeCardState({ ...base, thisBrowserConnected: true, environment: 'unsupported' })).toBe('connected');
  });
  test('Safari, Firefox and the desktop shell cannot add it', () => {
    expect(chromeCardState({ ...base, environment: 'unsupported' })).toBe('unsupported');
  });
  test('other browsers of the person never make this one connected', () => {
    expect(chromeCardState(base)).toBe('notInstalled');
    expect(chromeCardState({ ...base, installed: true })).toBe('installed');
  });
  test('waits for the first ping before offering the store', () => {
    expect(chromeCardState({ ...base, checking: true })).toBe('checking');
  });
});
