const { describe, expect, test } = require('bun:test');

const { PANEL_TOGGLE_COMMAND, forwardsPanelToggle } = require('./panel-shortcut');

const key = (overrides = {}) => ({
  type: 'keyDown',
  key: 'i',
  meta: true,
  control: false,
  alt: false,
  shift: false,
  isAutoRepeat: false,
  ...overrides,
});
const mainFrame = { parent: null };
const iframe = { parent: mainFrame };

describe('forwardsPanelToggle (KRTX-2944)', () => {
  test('⌘I in a cross-origin iframe is forwarded: the page never sees that key', () => {
    expect(forwardsPanelToggle(key(), iframe)).toBe(true);
  });

  test('Ctrl+I in an iframe is forwarded too, as the page treats it', () => {
    expect(forwardsPanelToggle(key({ meta: false, control: true }), iframe)).toBe(true);
  });

  test('caps lock still matches', () => {
    expect(forwardsPanelToggle(key({ key: 'I' }), iframe)).toBe(true);
  });

  test('the page keeps the key while its own document has focus', () => {
    expect(forwardsPanelToggle(key(), mainFrame)).toBe(false);
  });

  test('nothing is forwarded when no frame has focus', () => {
    expect(forwardsPanelToggle(key(), null)).toBe(false);
  });

  test('DevTools keeps ⌥⌘I and Ctrl+Shift+I', () => {
    expect(forwardsPanelToggle(key({ alt: true }), iframe)).toBe(false);
    expect(forwardsPanelToggle(key({ meta: false, control: true, shift: true, key: 'I' }), iframe)).toBe(false);
  });

  test('only one toggle per press: no keyUp, no auto-repeat', () => {
    expect(forwardsPanelToggle(key({ type: 'keyUp' }), iframe)).toBe(false);
    expect(forwardsPanelToggle(key({ isAutoRepeat: true }), iframe)).toBe(false);
  });

  test('a plain I, or another key with ⌘, stays in the iframe', () => {
    expect(forwardsPanelToggle(key({ meta: false }), iframe)).toBe(false);
    expect(forwardsPanelToggle(key({ key: 'j' }), iframe)).toBe(false);
  });

  test('the command is the one the web app listens for', () => {
    expect(PANEL_TOGGLE_COMMAND).toBe('toggle-right-panel');
  });
});
